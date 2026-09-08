// backend/src/util/timeout.js
//
// A strict wall-clock bound for anything that talks to a remote system.
//
// Ethers enforces its own `FetchRequest.timeout`, but only between retry
// attempts, and a provider that accepts a connection and then stalls can still
// outlive it. This wrapper is the application-level guarantee: past `ms` the
// caller gets an error, whatever the socket underneath is doing.
//
// The underlying request is NOT cancelled — ethers exposes no signal on
// `getBlockNumber()` and friends. It is bounded by the provider's own fetch
// timeout and abandoned here, so nothing downstream waits on it.

/** Distinguishable from a provider-reported timeout, and safe to log. */
class RpcTimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "RpcTimeoutError";
    this.code = "RPC_TIMEOUT";
    this.timeoutMs = ms;
    this.operation = label;
  }
}

/**
 * Resolves `promise`, or rejects with RpcTimeoutError after `ms`.
 *
 * A non-positive or non-finite `ms` disables the bound, which is what tests and
 * a deliberate `RPC_TIMEOUT_MS=0` want.
 */
const withTimeout = (promise, ms, label = "rpc call") => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve(promise);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RpcTimeoutError(label, ms));
    }, ms);

    // An abandoned pending request must not hold the event loop open.
    if (typeof timer.unref === "function") {
      timer.unref();
    }

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
};

/** Promise-based sleep that can be cut short. Returns `{ promise, cancel }`. */
const createCancellableSleep = (ms) => {
  let cancel = () => {};

  const promise = new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  return { promise, cancel };
};

const sleep = (ms) => createCancellableSleep(ms).promise;

/**
 * Exponential backoff with jitter, bounded by `maxMs`.
 *
 * Full jitter over the lower half of the window: long enough to actually back
 * off, random enough that several workers do not resynchronize on the provider.
 */
const backoffDelay = (attempt, { baseMs, maxMs, random = Math.random }) => {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));

  return Math.round(exponential / 2 + random() * (exponential / 2));
};

module.exports = {
  RpcTimeoutError,
  withTimeout,
  sleep,
  createCancellableSleep,
  backoffDelay,
};
