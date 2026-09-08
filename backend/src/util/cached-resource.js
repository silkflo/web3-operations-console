// backend/src/util/cached-resource.js
//
// One value, cached with a TTL, refreshed by at most one caller at a time.
//
// This is the piece that turns "every request rebuilds the snapshot" into "one
// refresh per TTL, shared by everyone waiting". Three behaviours matter:
//
//   1. COALESCING — concurrent callers join the in-flight refresh instead of
//      starting their own. `/splits` and `/summary` arriving together do one
//      set of chain reads, not two.
//   2. LAST-KNOWN-GOOD — when a refresh fails, the previous value is served up
//      to `maxStaleMs` old, labelled `stale`, never labelled current.
//      `maxStaleMs: 0` means NEVER serve stale — the value is dropped the
//      moment a refresh fails. Serving forever requires `Infinity`, spelled
//      out, because "0" reading as "unlimited" is the kind of default that is
//      discovered during an incident.
//   3. ERROR COOLDOWN — after a failure, `cooldownMs` passes before another
//      attempt. A provider returning 429 is not asked again on every request;
//      callers get the honest degraded answer immediately instead of waiting
//      for another timeout.
//
// States returned to the caller:
//   fresh        this call performed (or joined) a successful refresh
//   cached       served from memory, inside the TTL
//   stale        refresh failed or is on cooldown; previous value served
//   unavailable  nothing usable has ever been loaded

/**
 * @param {Object}   input
 * @param {string}   [input.name]
 * @param {Function} input.load
 * @param {number}   [input.ttlMs]       How long a value counts as current.
 * @param {number}   [input.maxStaleMs]  Oldest value still served after a
 *   failed refresh. `0` disables stale serving entirely; `Infinity` serves the
 *   last good value for as long as the process lives. Negative is rejected.
 * @param {number}   [input.cooldownMs]  Quiet period after a failure.
 * @param {Function} [input.now]
 */
const createCachedResource = ({
  name = "resource",
  load,
  ttlMs = 60000,
  maxStaleMs = 900000,
  cooldownMs = 0,
  now = () => Date.now(),
} = {}) => {
  if (typeof load !== "function") {
    throw new TypeError(`cached resource "${name}" needs a load function`);
  }

  if (!(maxStaleMs >= 0)) {
    throw new RangeError(
      `cached resource "${name}": maxStaleMs must be >= 0 (use Infinity to ` +
        "serve the last good value indefinitely)"
    );
  }

  let entry = null; // { value, loadedAt }
  let inflight = null;
  let lastError = null;
  let lastErrorAt = 0;

  const stats = {
    loads: 0,
    failures: 0,
    hits: 0,
    coalesced: 0,
    cooldownSkips: 0,
  };

  const ageMs = () => (entry ? Math.max(0, now() - entry.loadedAt) : null);

  const result = (state, { error = null } = {}) => ({
    name,
    state,
    value: entry ? entry.value : null,
    loadedAt: entry ? entry.loadedAt : null,
    ageMs: ageMs(),
    error,
    stats: { ...stats },
  });

  /**
   * Serves the previous value if it is still inside the stale window.
   *
   * `maxStaleMs: 0` means no window at all, so the value is dropped rather than
   * served — the opposite of the "0 is unlimited" convention, and chosen that
   * way because an operator setting the maximum stale age to zero is asking for
   * stale data NOT to be served.
   */
  const degraded = (error) => {
    const age = ageMs();

    if (entry && maxStaleMs > 0 && age <= maxStaleMs) {
      return result("stale", { error });
    }

    entry = null;

    return result("unavailable", { error });
  };

  const refresh = () => {
    if (inflight) {
      stats.coalesced += 1;
      return inflight;
    }

    stats.loads += 1;

    inflight = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          entry = { value, loadedAt: now() };
          lastError = null;
          lastErrorAt = 0;
          inflight = null;
          return result("fresh");
        },
        (error) => {
          stats.failures += 1;
          lastError = error;
          lastErrorAt = now();
          inflight = null;
          return degraded(error);
        }
      );

    return inflight;
  };

  /**
   * Returns the current value, refreshing only when that is both necessary and
   * allowed.
   *
   * @param {Object}  [options]
   * @param {boolean} [options.force]      Ignore the TTL and the cooldown.
   * @param {boolean} [options.allowLoad]  False never contacts the source; used
   *                                       by callers that must not block.
   */
  const get = async ({ force = false, allowLoad = true } = {}) => {
    if (!force && entry && ageMs() < ttlMs) {
      stats.hits += 1;
      return result("cached");
    }

    if (inflight) {
      stats.coalesced += 1;
      return inflight;
    }

    if (!allowLoad) {
      return entry ? result("stale") : result("unavailable", { error: lastError });
    }

    if (!force && lastError && now() - lastErrorAt < cooldownMs) {
      stats.cooldownSkips += 1;
      return degraded(lastError);
    }

    return refresh();
  };

  /** Synchronous read of whatever is held. Never starts a refresh. */
  const peek = () => {
    if (!entry) {
      return result("unavailable", { error: lastError });
    }

    return result(ageMs() < ttlMs ? "cached" : "stale", { error: lastError });
  };

  const clear = () => {
    entry = null;
    lastError = null;
    lastErrorAt = 0;
  };

  return {
    get,
    peek,
    clear,
    stats: () => ({ ...stats }),
    isRefreshing: () => Boolean(inflight),
  };
};

module.exports = { createCachedResource };
