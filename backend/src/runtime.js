// backend/src/runtime.js
//
// Assembles config, provider, chain reader and indexer. One place so the API,
// the CLI and the tests all build the same object graph.

const { ethers } = require("ethers");

const { buildConfig, assertRuntimeConfig } = require("./config");
const { getPrisma } = require("./db/client");
const { createProvider } = require("./chain/provider");
const { createChainReader } = require("./chain/reader");
const { createIndexer } = require("./indexer/indexer");

/**
 * @param {Object}  [input]
 * @param {boolean} [input.requireRpc]
 * @param {Object}  [input.logger]
 * @param {number}  [input.rpcTimeoutMs]  Per-call bound. The API wants a short
 *   one so it can degrade before Nginx does; the indexer wants a longer one,
 *   because a wide eth_getLogs is legitimately slower than a balance read.
 */
const createRuntime = ({
  requireRpc = true,
  logger = console,
  rpcTimeoutMs,
} = {}) => {
  const config = assertRuntimeConfig(buildConfig(), { requireRpc });
  const prisma = getPrisma();
  const timeoutMs = rpcTimeoutMs || config.rpc.timeoutMs;

  // Strictly bounded, no transport-level retry storm, network pinned so no
  // eth_chainId round-trip and no unbounded bootstrap loop. See chain/provider.
  const provider = createProvider({
    rpcUrl: config.rpcUrl,
    chainId: config.chainId,
    timeoutMs,
    maxAttempts: config.rpc.maxAttempts,
  });

  const reader = provider
    ? createChainReader({
        provider,
        createContract: (address, abi) =>
          new ethers.Contract(address, abi, provider),
        timeoutMs,
      })
    : null;

  const indexer = reader
    ? createIndexer({ prisma, reader, config, logger })
    : null;

  return { config, prisma, provider, reader, indexer };
};

module.exports = { createRuntime };
