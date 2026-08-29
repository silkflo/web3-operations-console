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

const intFromEnv = (name, fallback) => {
  const raw = process.env[name];

  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
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

    indexer: {
      confirmations: intFromEnv("WEB3_INDEXER_CONFIRMATIONS", 6),
      chunkSize: intFromEnv("WEB3_INDEXER_CHUNK_SIZE", 2000),
      pollMs: intFromEnv("WEB3_INDEXER_POLL_MS", 15000),
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
