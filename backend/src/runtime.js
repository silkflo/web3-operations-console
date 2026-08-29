// backend/src/runtime.js
//
// Assembles config, provider, chain reader and indexer. One place so the API,
// the CLI and the tests all build the same object graph.

const { ethers } = require("ethers");

const { buildConfig, assertRuntimeConfig } = require("./config");
const { getPrisma } = require("./db/client");
const { createChainReader } = require("./chain/reader");
const { createIndexer } = require("./indexer/indexer");

const createRuntime = ({ requireRpc = true, logger = console } = {}) => {
  const config = assertRuntimeConfig(buildConfig(), { requireRpc });
  const prisma = getPrisma();

  // Pinned network: skips a chainId round-trip per call and stops ethers from
  // failing a batch with "could not detect network" on a slow response.
  const provider = config.rpcUrl
    ? new ethers.JsonRpcProvider(config.rpcUrl, {
        chainId: config.chainId,
        name: "sepolia",
      })
    : null;

  const reader = provider
    ? createChainReader({
        provider,
        createContract: (address, abi) =>
          new ethers.Contract(address, abi, provider),
      })
    : null;

  const indexer = reader
    ? createIndexer({ prisma, reader, config, logger })
    : null;

  return { config, prisma, provider, reader, indexer };
};

module.exports = { createRuntime };
