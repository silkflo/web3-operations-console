// lib/dashboard-poller.js
//
// The console's refresh lifecycle, kept out of the React component so it can be
// tested directly rather than through a rendered tree.
//
// What it replaces: a bare `setInterval` firing every 15 seconds, which fetched
// three endpoints concurrently whether or not the previous round had finished,
// and kept firing in a background tab nobody was looking at. Each refresh cost
// 3 HTTP requests and, because each endpoint rebuilt its own snapshot, about 45
// JSON-RPC operations — so one continuously open, visible tab made roughly 12
// requests and 180 RPC operations a minute.
//
// Four rules:
//   1. never start a refresh while one is in flight;
//   2. pause while the tab is hidden;
//   3. refresh on becoming visible, but not more often than the minimum;
//   4. a manual refresh always works, and never runs twice at once.
//
// Every dependency that makes timing hard to test — the clock, the timers, the
// visibility source — is injected, so the tests are deterministic and instant.

/** Conservative for a portfolio demo. Overridable at build time. */
const DEFAULT_REFRESH_MS = 90000;

/** Bounds accepted from configuration. */
const MIN_REFRESH_MS = 30000;
const MAX_REFRESH_MS = 600000;

/** Shortest gap between a visibility-triggered refresh and the previous one. */
const DEFAULT_MIN_VISIBLE_REFRESH_MS = 30000;

/**
 * Refresh interval from the build-time environment, clamped to something sane.
 *
 * A misconfigured value degrades to the default rather than letting a typo
 * point a public demo back at a 1-second poll.
 */
const resolveRefreshIntervalMs = (raw) => {
  const value =
    raw !== undefined
      ? raw
      : typeof process !== "undefined" &&
        process.env &&
        process.env.NEXT_PUBLIC_WEB3_REFRESH_MS;

  const parsed = Number.parseInt(String(value === undefined ? "" : value), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REFRESH_MS;
  }

  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, parsed));
};

/** Browser visibility, or a permanently visible stub during SSR and in tests. */
const documentVisibility = () => {
  if (typeof document === "undefined") {
    return { isHidden: () => false, subscribe: () => () => {} };
  }

  return {
    isHidden: () => document.visibilityState === "hidden",
    subscribe: (listener) => {
      const handler = () => listener(document.visibilityState !== "hidden");

      document.addEventListener("visibilitychange", handler);

      return () => document.removeEventListener("visibilitychange", handler);
    },
  };
};

/**
 * @param {Object}   input
 * @param {Function} input.load                  ({ reason }) => Promise. Owns
 *                                               its own error handling.
 * @param {number}   [input.intervalMs]
 * @param {number}   [input.minVisibleRefreshMs]
 * @param {Function} [input.now]
 * @param {Function} [input.setTimer]
 * @param {Function} [input.clearTimer]
 * @param {Object}   [input.visibility]
 * @param {Function} [input.onError]
 */
const createDashboardPoller = ({
  load,
  intervalMs = DEFAULT_REFRESH_MS,
  minVisibleRefreshMs = DEFAULT_MIN_VISIBLE_REFRESH_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  visibility = documentVisibility(),
  onError = () => {},
} = {}) => {
  if (typeof load !== "function") {
    throw new TypeError("createDashboardPoller needs a load function");
  }

  let started = false;
  let inflight = null;
  let timer = null;
  let unsubscribe = null;
  let lastStartedAt = 0;

  const stats = {
    loads: 0,
    overlapsPrevented: 0,
    pauses: 0,
    visibilityRefreshes: 0,
    scheduled: 0,
  };

  const cancelTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  /**
   * Arms the next refresh.
   *
   * A hidden tab arms nothing at all — that is the pause. Becoming visible
   * re-arms it, so no work is queued up waiting to fire in a burst.
   */
  const schedule = (delayMs = intervalMs) => {
    cancelTimer();

    if (!started) {
      return;
    }

    if (visibility.isHidden()) {
      stats.pauses += 1;
      return;
    }

    stats.scheduled += 1;
    timer = setTimer(() => {
      timer = null;
      refresh({ reason: "interval" });
    }, Math.max(0, delayMs));
  };

  /**
   * Refreshes once.
   *
   * Concurrent callers — the interval, a visibility change and the Retry button
   * all landing together — share the one in-flight load rather than stacking
   * requests on an API that may already be struggling.
   */
  const refresh = (options = {}) => {
    const reason = options.reason || "manual";

    if (inflight) {
      stats.overlapsPrevented += 1;
      return inflight;
    }

    lastStartedAt = now();
    stats.loads += 1;

    inflight = Promise.resolve()
      .then(() => load({ reason }))
      .catch((error) => {
        onError(error);
        return undefined;
      })
      .then((value) => {
        inflight = null;
        // Rescheduled after completion, never before: the gap is between
        // refreshes, not between the starts of overlapping ones.
        schedule();
        return value;
      });

    return inflight;
  };

  const handleVisibility = (visible) => {
    if (!started) {
      return;
    }

    if (!visible) {
      cancelTimer();
      stats.pauses += 1;
      return;
    }

    const elapsed = now() - lastStartedAt;

    if (elapsed >= minVisibleRefreshMs) {
      stats.visibilityRefreshes += 1;
      refresh({ reason: "visible" });
      return;
    }

    // Too soon to be worth a request; resume on the remainder instead.
    schedule(minVisibleRefreshMs - elapsed);
  };

  const start = () => {
    if (started) {
      return inflight || Promise.resolve();
    }

    started = true;
    unsubscribe = visibility.subscribe(handleVisibility);

    return refresh({ reason: "initial" });
  };

  const stop = () => {
    started = false;
    cancelTimer();

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  return {
    start,
    stop,
    refresh,
    isRefreshing: () => Boolean(inflight),
    isPaused: () => started && timer === null && !inflight,
    stats: () => ({ ...stats }),
  };
};

module.exports = {
  DEFAULT_REFRESH_MS,
  MIN_REFRESH_MS,
  MAX_REFRESH_MS,
  DEFAULT_MIN_VISIBLE_REFRESH_MS,
  resolveRefreshIntervalMs,
  documentVisibility,
  createDashboardPoller,
};
