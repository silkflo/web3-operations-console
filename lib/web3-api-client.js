// lib/web3-api-client.js
//
// The frontend's only route to Web3 data.
//
// After Milestone 3 the browser performs no eth_getLogs scan and holds no RPC
// credential: it reads the indexed API over HTTPS. There is no Prisma import
// here and no database URL — those exist only on the VPS.
//
// Next.js injects NEXT_PUBLIC_* values into the browser bundle at build time.
// If this variable is omitted, the build still succeeds and the UI reports the
// API as unconfigured. Setting it later requires a rebuild and redeployment.

/** Lag beyond which indexed data is presented as stale. */
const STALE_LAG_BLOCKS = 50;

/** Resolves the API base, or null when none is configured. */
const getApiBaseUrl = () => {
  const raw =
    (typeof process !== "undefined" &&
      process.env &&
      process.env.NEXT_PUBLIC_WEB3_API_URL) ||
    "";

  const trimmed = String(raw).trim().replace(/\/+$/, "");

  return trimmed || null;
};

class Web3ApiError extends Error {
  constructor(message, { status = null, requestId = null, cause = null } = {}) {
    super(message);
    this.name = "Web3ApiError";
    this.status = status;
    this.requestId = requestId;
    this.cause = cause;
  }
}

const NOT_CONFIGURED =
  "The Web3 API is not configured for this deployment (NEXT_PUBLIC_WEB3_API_URL is unset).";

/**
 * GETs one API path.
 *
 * Distinguishes "not configured", "unreachable" and "responded with an error",
 * because the UI says something different for each.
 */
const apiGet = async (path, { signal, timeoutMs = 12000 } = {}) => {
  const base = getApiBaseUrl();

  if (!base) {
    throw new Web3ApiError(NOT_CONFIGURED, { status: null });
  }

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    controller && timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  if (signal && controller) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let response;

  try {
    response = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { accept: "application/json" },
      // Public read endpoints need no cookies or credentials.
      credentials: "omit",
      signal: controller ? controller.signal : undefined,
    });
  } catch (error) {
    throw new Web3ApiError(
      "Could not reach the Web3 API. It may be offline or blocked by CORS.",
      { cause: error }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  let body = null;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Web3ApiError(
      (body && body.message) ||
        `The Web3 API responded with HTTP ${response.status}.`,
      {
        status: response.status,
        requestId: body && body.requestId,
      }
    );
  }

  return body;
};

/**
 * Derives the freshness banner state from /health.
 *
 * Kept here rather than in the component so it is unit-testable.
 */
const describeFreshness = (health) => {
  if (!health) {
    return { level: "unknown", label: "Unknown", detail: null };
  }

  if (health.database === "down") {
    return {
      level: "error",
      label: "Index unavailable",
      detail: "The API cannot reach its database.",
    };
  }

  const lag = health.indexerLagBlocks;
  const stale = health.stale || (lag !== null && lag > STALE_LAG_BLOCKS);

  if (stale) {
    return {
      level: "stale",
      label: "Indexed data may be stale",
      detail:
        lag !== null
          ? `The indexer is ${lag} block${lag === 1 ? "" : "s"} behind the chain.`
          : "The indexer has not reported a successful sync recently.",
    };
  }

  return {
    level: "fresh",
    label: "Index current",
    detail:
      lag !== null
        ? `${lag} block${lag === 1 ? "" : "s"} behind the chain head.`
        : null,
  };
};

const createWeb3ApiClient = (options = {}) => ({
  isConfigured: () => Boolean(getApiBaseUrl()),
  baseUrl: () => getApiBaseUrl(),

  health: (opts) => apiGet("/health", { ...options, ...opts }),
  summary: (opts) => apiGet("/api/v1/web3/summary", { ...options, ...opts }),
  splits: (opts) => apiGet("/api/v1/web3/splits", { ...options, ...opts }),
  split: (address, opts) =>
    apiGet(`/api/v1/web3/splits/${address}`, { ...options, ...opts }),
  activity: (limit = 50, opts) =>
    apiGet(`/api/v1/web3/activity?limit=${limit}`, { ...options, ...opts }),
  questions: (opts) => apiGet("/api/v1/web3/questions", { ...options, ...opts }),
  intelligence: (questionId, opts) =>
    apiGet(`/api/v1/web3/intelligence/${questionId}`, { ...options, ...opts }),
});

module.exports = {
  STALE_LAG_BLOCKS,
  NOT_CONFIGURED,
  Web3ApiError,
  apiGet,
  getApiBaseUrl,
  describeFreshness,
  createWeb3ApiClient,
};
