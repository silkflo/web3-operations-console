// lib/contract-intelligence/loader.js
//
// LEGACY TEST-ONLY ADAPTER.
//
// This direct-RPC snapshot loader is retained for M1/M2 regression tests only.
// It is not imported by the production frontend or backend. The deployed M3
// architecture uses the VPS indexer, PostgreSQL read model, and Fastify API.
// The browser never constructs a provider or scans Ethereum event logs.

const { buildSplitSnapshot, buildFactorySnapshot } = require("./model");
const { SNAPSHOT_TTL_MS } = require("./constants");

/** Normalizes an ethers v6 EventLog into the plain shape the model expects. */
const normalizeLog = (log, eventName) => ({
  eventName,
  blockNumber: log.blockNumber,
  logIndex: log.index !== undefined ? log.index : log.logIndex,
  transactionHash: log.transactionHash,
  args: log.args,
});

/** Queries one event type, returning [] and a warning if the RPC refuses. */
const safeQuery = async (contract, filterName, fromBlock, toBlock, warnings) => {
  try {
    const logs = await contract.queryFilter(
      contract.filters[filterName](),
      fromBlock,
      toBlock
    );

    return { logs: logs.map((log) => normalizeLog(log, filterName)), ok: true };
  } catch (error) {
    warnings.push(
      `${filterName} logs could not be read: ${
        error.shortMessage || error.message
      }`
    );

    return { logs: [], ok: false };
  }
};

/**
 * Loads and normalizes the full factory snapshot.
 *
 * @param {Object} input
 * @param {Object} input.provider        Reused pinned provider (reads only).
 * @param {Function} input.createContract (address, abi) => contract bound to it.
 * @param {string} input.factoryAddress
 * @param {Array} input.factoryAbi
 * @param {Array} input.splitAbi
 * @param {number} input.deploymentBlock
 * @returns {Promise<import("./model").FactorySnapshot>}
 */
const loadFactorySnapshot = async ({
  provider,
  createContract,
  factoryAddress,
  factoryAbi,
  splitAbi,
  deploymentBlock,
}) => {
  const warnings = [];
  const factory = createContract(factoryAddress, factoryAbi);

  const [latestBlock, factoryInfo, splitsResult] = await Promise.all([
    provider.getBlockNumber(),
    factory.getFactoryInfo(),
    factory.getSplits(0),
  ]);

  const [version, deployedSplitCount] = factoryInfo;
  const [indexed] = splitsResult;

  // Bounded to the demo deployment; never a full-chain scan.
  const fromBlock = deploymentBlock;
  const toBlock = latestBlock;

  const creationQuery = await safeQuery(
    factory,
    "SplitCreated",
    fromBlock,
    toBlock,
    warnings
  );

  const creationByAddress = new Map();
  creationQuery.logs.forEach((log) => {
    creationByAddress.set(String(log.args.splitAddress).toLowerCase(), log);
  });

  const splits = await Promise.all(
    indexed.map(async (entry) => {
      const address = entry.splitAddress ?? entry[0];
      const contract = createContract(address, splitAbi);

      const [
        title,
        version_,
        round,
        participantCount,
        balanceWei,
        roundPoolWei,
        totalClaimableWei,
      ] = await Promise.all([
        contract.title(),
        contract.VERSION(),
        contract.round(),
        contract.participantCount(),
        contract.contractBalance(),
        contract.availableForDistribution(),
        contract.totalClaimable(),
      ]);

      const splitWarnings = [];

      const [joined, funded, finalized, withdrawn] = await Promise.all([
        safeQuery(contract, "ParticipantJoined", fromBlock, toBlock, splitWarnings),
        safeQuery(contract, "Funded", fromBlock, toBlock, splitWarnings),
        safeQuery(contract, "DistributionFinalized", fromBlock, toBlock, splitWarnings),
        safeQuery(contract, "Withdrawal", fromBlock, toBlock, splitWarnings),
      ]);

      splitWarnings.forEach((warning) => warnings.push(`${title}: ${warning}`));

      return buildSplitSnapshot({
        reads: {
          address,
          title,
          version: version_,
          round,
          participantCount,
          balanceWei,
          roundPoolWei,
          totalClaimableWei,
        },
        events: {
          joined: joined.logs,
          funded: funded.logs,
          finalized: finalized.logs,
          withdrawn: withdrawn.logs,
        },
        creation: creationByAddress.get(String(address).toLowerCase()) || null,
        atBlock: latestBlock,
        historyComplete:
          joined.ok && funded.ok && finalized.ok && withdrawn.ok && creationQuery.ok,
      });
    })
  );

  return buildFactorySnapshot({
    address: factoryAddress,
    version,
    deployedSplitCount: Number(deployedSplitCount),
    deploymentBlock,
    generatedAtBlock: latestBlock,
    splits,
    warnings,
  });
};

/**
 * Memoizes snapshots so clicking through five questions costs one load, and the
 * 15-second latest-block poll does not trigger a re-scan of historical logs.
 */
const createSnapshotCache = ({ ttlMs = SNAPSHOT_TTL_MS } = {}) => {
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;

  const isFresh = (now, latestBlock) => {
    if (!cached) return false;
    if (now - cachedAt > ttlMs) return false;
    // A newer block may carry new events, so the snapshot is stale.
    if (latestBlock !== undefined && latestBlock > cached.generatedAtBlock) {
      return false;
    }
    return true;
  };

  return {
    /**
     * @param {Function} load  Async factory returning a fresh snapshot.
     * @param {Object} [options]
     * @param {number} [options.latestBlock] Newest known block, if already read.
     * @param {boolean} [options.force]
     */
    async get(load, { latestBlock, force = false } = {}) {
      const now = Date.now();

      if (!force && isFresh(now, latestBlock)) {
        return cached;
      }

      // Collapse concurrent requests onto one network round-trip.
      if (inFlight) {
        return inFlight;
      }

      inFlight = load()
        .then((snapshot) => {
          cached = snapshot;
          cachedAt = Date.now();
          return snapshot;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    },

    peek: () => cached,
    clear: () => {
      cached = null;
      cachedAt = 0;
    },
  };
};

module.exports = { loadFactorySnapshot, createSnapshotCache, normalizeLog };
