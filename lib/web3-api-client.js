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

/**
 * Client-side abort.
 *
 * This is a backstop, not the primary bound. The API now answers with cached or
 * indexed data well inside it (see backend/src/api/snapshot.js); if this timer
 * is ever what fires, something upstream is broken.
 */
const DEFAULT_TIMEOUT_MS = 10000;

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
const apiGet = async (path, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
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

  // The API is explicit about serving a snapshot it could not refresh. Say so
  // rather than presenting cached figures as current live-chain values.
  if (health.servingStaleData) {
    return {
      level: "stale",
      label: "Showing last known good data",
      detail:
        "The API could not refresh from the chain, so these are the most " +
        "recent values it holds, not current live-chain values.",
    };
  }

  if (health.rpc === "down" || health.rpc === "degraded") {
    return {
      level: "stale",
      label: "Live chain reads unavailable",
      detail:
        "Current balances come from the index rather than from live contract " +
        "reads, so they may lag the chain.",
    };
  }

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

/**
 * Classifies what the currently displayed figures actually are.
 *
 * A 200 response is not evidence that the data in it is live. The dashboard can
 * answer perfectly while every contract read behind it failed, and the page used
 * to call that "Live" because the HTTP request succeeded. This is the single
 * place that decides otherwise, so no component can accidentally claim more than
 * the payload supports.
 *
 * `isLive` is deliberately conservative: anything it cannot positively confirm —
 * a missing freshness block, an older backend, a partial read — is not live.
 *
 * @param {Object|null} payload A dashboard payload, or null before the first
 *   successful response.
 */
const describeDataState = (payload) => {
  const freshness = (payload && payload.freshness) || null;
  const health = (payload && payload.health) || null;

  const unknown = {
    level: "unknown",
    isLive: false,
    label: "Unknown",
    detail: null,
    currentState: null,
  };

  if (!payload || !freshness) {
    return unknown;
  }

  const coverage = freshness.currentState || null;
  const rpcDown = Boolean(health && health.rpc && health.rpc !== "up");

  const isLive =
    freshness.source === "live" &&
    freshness.degraded !== true &&
    freshness.stale !== true &&
    !rpcDown;

  if (isLive) {
    return {
      level: "live",
      isLive: true,
      label: "Live",
      detail: "Current values read from the contracts.",
      currentState: coverage,
    };
  }

  if (freshness.stale) {
    return {
      level: "stale",
      isLive: false,
      label: "Stale",
      detail:
        "The last refresh failed. These are the most recent values the API " +
        "holds, not current live-chain values.",
      currentState: coverage,
    };
  }

  // Partial failure gets counted out loud rather than rounded to "degraded".
  const detail = coverage
    ? `${coverage.live} of ${coverage.total} contracts read live` +
      (coverage.lastKnownGood
        ? `; ${coverage.lastKnownGood} from an earlier read`
        : "") +
      (coverage.derived
        ? `; ${coverage.derived} reconstructed from indexed events`
        : "") +
      "."
    : "Current contract reads are unavailable.";

  return {
    level: "degraded",
    isLive: false,
    label: coverage && coverage.live > 0 ? "Partly live" : "Indexed only",
    detail,
    currentState: coverage,
  };
};

/**
 * Reshapes the legacy three-call payload into the combined dashboard shape.
 *
 * Only used against a backend that predates `/api/v1/web3/dashboard`, so a
 * frontend deployed ahead of its API still renders instead of going blank.
 */
const combineLegacyPayloads = ({ health, splits, summary }) => ({
  generatedAtBlock: splits.generatedAtBlock,
  splits: splits.splits,
  warnings: splits.warnings || [],
  freshness: splits.freshness || null,
  summary: summary || null,
  health: health || null,
  legacy: true,
});

const createWeb3ApiClient = (options = {}) => {
  // Remembered per client instance: once the combined route has 404ed there is
  // no point paying for the probe on every refresh.
  let dashboardSupported = true;

  const client = {
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

    /**
     * Everything the console renders, in one request.
     *
     * The whole page used to cost three concurrent requests every 15 seconds.
     * This is one request on a conservative interval, answered from the backend's
     * shared snapshot cache.
     */
    dashboard: async (opts) => {
      if (dashboardSupported) {
        try {
          return await apiGet("/api/v1/web3/dashboard", { ...options, ...opts });
        } catch (error) {
          if (!(error instanceof Web3ApiError) || error.status !== 404) {
            throw error;
          }

          dashboardSupported = false;
        }
      }

      const [health, splits, summary] = await Promise.all([
        client.health(opts).catch(() => null),
        client.splits(opts),
        client.summary(opts).catch(() => null),
      ]);

      return combineLegacyPayloads({ health, splits, summary });
    },

    supportsDashboard: () => dashboardSupported,
  };

  return client;
};

module.exports = {
  STALE_LAG_BLOCKS,
  DEFAULT_TIMEOUT_MS,
  combineLegacyPayloads,
  describeDataState,
  NOT_CONFIGURED,
  Web3ApiError,
  apiGet,
  getApiBaseUrl,
  describeFreshness,
  createWeb3ApiClient,
};
