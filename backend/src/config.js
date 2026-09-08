// backend/src/config.js
//
// Backend configuration. Secrets come from environment variables only.
//
// The factory address and deployment block are read from the committed
// deployment manifest by default, so there is exactly one source of truth for
// them across contracts, frontend config and this backend. The env vars exist
// only to point the indexer at a different deployment.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const MANIFEST_PATH = path.join(
  __dirname,
  "..",
  "..",
  "ethereum-v3",
  "deployments",
  "sepolia-demo-v1.json"
);

const readManifest = () => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
};

const intFromEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }

  if (parsed < min || parsed > max) {
    throw new Error(
      `${name} must be between ${min} and ${max}, got "${raw}"`
    );
  }

  return parsed;
};

const listFromEnv = (name, fallback) => {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
};

const buildConfig = () => {
  const manifest = readManifest();

  // Deliberately clamped rather than rejected: an existing deployment may
  // already run a very small chunk size, and a configuration error must not be
  // the reason the API refuses to start.
  const chunkSize = intFromEnv("WEB3_INDEXER_CHUNK_SIZE", 2000, {
    min: 1,
    max: 100000,
  });
  const minChunkSize = Math.min(
    chunkSize,
    intFromEnv("WEB3_INDEXER_MIN_CHUNK_SIZE", 25, { min: 1, max: 100000 })
  );

  const factoryAddress =
    process.env.WEB3_FACTORY_ADDRESS ||
    (manifest && manifest.factoryAddress) ||
    null;

  const deploymentBlock = process.env.WEB3_FACTORY_DEPLOYMENT_BLOCK
    ? intFromEnv("WEB3_FACTORY_DEPLOYMENT_BLOCK")
    : manifest && manifest.deploymentBlockNumber;

  return {
    databaseUrl: process.env.DATABASE_URL || null,
    rpcUrl: process.env.SEPOLIA_RPC_URL || null,

    chainId: (manifest && manifest.chainId) || 11155111,
    factoryAddress,
    deploymentBlock: deploymentBlock || null,
    factoryVersion: (manifest && manifest.factoryVersion) || null,

    // Transport-level limits. Ethers defaults (300s timeout, 12 retries on a
    // 429) are far too generous for a request that must answer before Nginx
    // times out; see src/chain/provider.js.
    rpc: {
      timeoutMs: intFromEnv("RPC_TIMEOUT_MS", 8000, { min: 250, max: 60000 }),
      maxAttempts: intFromEnv("RPC_MAX_ATTEMPTS", 1, { min: 1, max: 5 }),
    },

    indexer: {
      confirmations: intFromEnv("WEB3_INDEXER_CONFIRMATIONS", 6),
      // Largest range attempted. Shrunk automatically, down to
      // minChunkSize, when a provider refuses the range.
      chunkSize,
      minChunkSize,
      // Steady state: how long to wait after a pass that reached the head.
      pollMs: intFromEnv("WEB3_INDEXER_POLL_MS", 60000, { min: 1000 }),
      // Catch-up: how long to wait after a pass that did NOT reach the head.
      catchUpPollMs: intFromEnv("WEB3_INDEXER_CATCHUP_POLL_MS", 2000, {
        min: 0,
      }),
      // Breathing room between chunks so a backlog does not monopolise the
      // shared RPC while the API is trying to serve requests through it.
      chunkDelayMs: intFromEnv("WEB3_INDEXER_CHUNK_DELAY_MS", 250, { min: 0 }),
      // 0 disables the cap. A bounded pass keeps shutdown responsive and lets
      // an operator meter a large catch-up.
      maxBlocksPerPass: intFromEnv("WEB3_INDEXER_MAX_BLOCKS_PER_PASS", 5000, {
        min: 0,
      }),
      rpcTimeoutMs: intFromEnv("WEB3_INDEXER_RPC_TIMEOUT_MS", 20000, {
        min: 250,
        max: 120000,
      }),
      maxAttempts: intFromEnv("WEB3_INDEXER_MAX_ATTEMPTS", 4, {
        min: 1,
        max: 20,
      }),
      backoffMs: intFromEnv("WEB3_INDEXER_BACKOFF_MS", 2000, { min: 100 }),
      backoffMaxMs: intFromEnv("WEB3_INDEXER_BACKOFF_MAX_MS", 300000, {
        min: 1000,
      }),
      reorgDepth: intFromEnv("WEB3_INDEXER_REORG_DEPTH", 24),
    },

    api: {
      host: process.env.API_HOST || "127.0.0.1",
      port: intFromEnv("API_PORT", 4000),
      corsOrigins: listFromEnv("CORS_ALLOWED_ORIGINS", [
        "http://localhost:3000",
      ]),
      rateLimitMax: intFromEnv("API_RATE_LIMIT_MAX", 120),
      rateLimitWindow: process.env.API_RATE_LIMIT_WINDOW || "1 minute",
      staleAfterSeconds: intFromEnv("API_STALE_AFTER_SECONDS", 300),
      // One snapshot refresh per TTL, shared by every concurrent caller.
      snapshotTtlSeconds: intFromEnv("API_SNAPSHOT_TTL_SECONDS", 60, {
        min: 1,
        max: 3600,
      }),
      // Oldest snapshot still served, clearly labelled, when a refresh fails.
      snapshotMaxStaleSeconds: intFromEnv(
        "API_SNAPSHOT_MAX_STALE_SECONDS",
        900,
        { min: 0, max: 86400 }
      ),
      chainHeadTtlSeconds: intFromEnv("API_CHAIN_HEAD_TTL_SECONDS", 15, {
        min: 1,
        max: 3600,
      }),
      // After an RPC failure, wait this long before trying the provider again
      // instead of spending a timeout on every request that arrives.
      rpcErrorCooldownSeconds: intFromEnv("API_RPC_ERROR_COOLDOWN_SECONDS", 30, {
        min: 0,
        max: 3600,
      }),
      // /health must answer a monitor quickly even when nothing else works.
      healthTimeoutMs: intFromEnv("API_HEALTH_TIMEOUT_MS", 2000, {
        min: 100,
        max: 30000,
      }),
      logLevel: process.env.LOG_LEVEL || "info",
    },
  };
};

/** Throws with a readable message when something required is missing. */
const assertRuntimeConfig = (config, { requireRpc = true } = {}) => {
  const problems = [];

  if (!config.databaseUrl) {
    problems.push("DATABASE_URL is not set");
  }

  if (requireRpc && !config.rpcUrl) {
    problems.push("SEPOLIA_RPC_URL is not set");
  }

  if (!config.factoryAddress) {
    problems.push(
      "No factory address: set WEB3_FACTORY_ADDRESS or restore the deployment manifest"
    );
  }

  if (!config.deploymentBlock) {
    problems.push(
      "No deployment block: set WEB3_FACTORY_DEPLOYMENT_BLOCK or restore the deployment manifest"
    );
  }

  if (
    config.indexer &&
    config.indexer.backoffMs > config.indexer.backoffMaxMs
  ) {
    problems.push(
      "WEB3_INDEXER_BACKOFF_MS must not exceed WEB3_INDEXER_BACKOFF_MAX_MS"
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Backend configuration is incomplete:\n - ${problems.join(
        "\n - "
      )}\nSee backend/.env.example.`
    );
  }

  return config;
};

module.exports = { buildConfig, assertRuntimeConfig, MANIFEST_PATH };
