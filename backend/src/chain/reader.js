// backend/src/chain/reader.js
//
// All Sepolia RPC access lives here. This is the code that used to run in the
// visitor's browser in Milestone 2; moving it server-side is the point of this
// milestone.
//
// It does no database work and holds no Prisma import, so it can be unit-tested
// against a stub provider.

const path = require("path");

const { withTimeout } = require("../util/timeout");

const ABI_DIR = path.join(__dirname, "..", "..", "..", "ethereum-v3", "frontend");

const factoryAbi = require(path.join(ABI_DIR, "SplitFactory.abi.json"));
const splitAbi = require(path.join(ABI_DIR, "EthSplit.abi.json"));

/** Event names persisted per contract kind. Matches the real V3 ABI exactly. */
const FACTORY_EVENTS = ["SplitCreated"];
const SPLIT_EVENTS = [
  "ParticipantJoined",
  "Funded",
  "DistributionFinalized",
  "Withdrawal",
];

/** uint256 values are stringified so JSON never loses precision. */
const serializeArgs = (fragment, args) => {
  const out = {};

  fragment.inputs.forEach((input, index) => {
    const value = args[index];
    out[input.name] =
      typeof value === "bigint" ? value.toString() : String(value);
  });

  return out;
};

/**
 * Normalizes an ethers v6 log into the row shape the indexer persists.
 *
 * Round and amount are lifted out of args into dedicated columns because every
 * hot query filters on them.
 */
const normalizeLog = (log, contractAddress) => {
  const name = log.fragment ? log.fragment.name : null;

  if (!name) {
    return null;
  }

  const args = serializeArgs(log.fragment, log.args);

  const round =
    args.round !== undefined ? Number.parseInt(args.round, 10) : null;

  const amountKey = ["amount", "totalDistributed"].find(
    (key) => args[key] !== undefined
  );

  return {
    eventName: name,
    address: contractAddress.toLowerCase(),
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.index !== undefined ? log.index : log.logIndex,
    args,
    round: Number.isInteger(round) ? round : null,
    amount: amountKey ? args[amountKey] : null,
  };
};

/**
 * Reads logs for one contract over a bounded block range.
 *
 * Never scans from genesis: `fromBlock` is always the factory deployment block
 * or a stored checkpoint.
 */
const fetchLogs = async ({
  contract,
  address,
  eventNames,
  fromBlock,
  toBlock,
  timeoutMs,
}) => {
  const rows = [];

  for (const eventName of eventNames) {
    // Bounded per event name rather than per range: one unresponsive
    // eth_getLogs must not consume the budget of the three that follow it.
    const logs = await withTimeout(
      contract.queryFilter(contract.filters[eventName](), fromBlock, toBlock),
      timeoutMs,
      `eth_getLogs ${eventName} ${fromBlock}-${toBlock}`
    );

    logs.forEach((log) => {
      const normalized = normalizeLog(log, address);

      if (normalized) {
        rows.push(normalized);
      }
    });
  }

  return rows.sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
  );
};

/** No bound at all is never the answer; this is the fallback if none is given. */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Creates the chain reader.
 *
 * Every method is wrapped in a strict wall-clock timeout. Without it a stalled
 * or throttled provider holds an API request open until Nginx gives up, which
 * is exactly how a rate limit turned into a 504 rather than a degraded page.
 *
 * @param {Object} input
 * @param {Object} input.provider        ethers Provider (or a stub in tests).
 * @param {Function} input.createContract (address, abi) => contract.
 * @param {number} [input.timeoutMs]     Hard bound for each RPC operation.
 */
const createChainReader = ({
  provider,
  createContract,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => ({
  factoryAbi,
  splitAbi,
  timeoutMs,

  async getBlockNumber() {
    return withTimeout(provider.getBlockNumber(), timeoutMs, "eth_blockNumber");
  },

  async getBlock(blockNumber) {
    return withTimeout(
      provider.getBlock(blockNumber),
      timeoutMs,
      `eth_getBlockByNumber ${blockNumber}`
    );
  },

  /** Confirmed head: the newest block deep enough to be safe to index. */
  async getConfirmedHead(confirmations) {
    const head = await withTimeout(
      provider.getBlockNumber(),
      timeoutMs,
      "eth_blockNumber"
    );

    return Math.max(0, head - confirmations);
  },

  async getFactoryInfo(address) {
    const factory = createContract(address, factoryAbi);
    const [version, deployedSplits] = await withTimeout(
      factory.getFactoryInfo(),
      timeoutMs,
      "getFactoryInfo"
    );

    return {
      version: String(version),
      deployedSplitCount: Number(deployedSplits),
    };
  },

  async fetchFactoryLogs(address, fromBlock, toBlock) {
    return fetchLogs({
      contract: createContract(address, factoryAbi),
      address,
      eventNames: FACTORY_EVENTS,
      fromBlock,
      toBlock,
      timeoutMs,
    });
  },

  async fetchSplitLogs(address, fromBlock, toBlock) {
    return fetchLogs({
      contract: createContract(address, splitAbi),
      address,
      eventNames: SPLIT_EVENTS,
      fromBlock,
      toBlock,
      timeoutMs,
    });
  },

  /** Current on-chain state of one split. Reads, never events. */
  async readSplitState(address) {
    const split = createContract(address, splitAbi);

    // Ethers batches these seven calls into one HTTP request, so a single
    // bound around the batch is the bound on the request that carries it.
    const [
      title,
      version,
      round,
      participantCount,
      balanceWei,
      roundPoolWei,
      totalClaimableWei,
    ] = await withTimeout(
      Promise.all([
        split.title(),
        split.VERSION(),
        split.round(),
        split.participantCount(),
        split.contractBalance(),
        split.availableForDistribution(),
        split.totalClaimable(),
      ]),
      timeoutMs,
      `readSplitState ${address}`
    );

    return {
      address,
      title: String(title),
      version: String(version),
      round: Number(round),
      participantCount: Number(participantCount),
      balanceWei: BigInt(balanceWei),
      roundPoolWei: BigInt(roundPoolWei),
      totalClaimableWei: BigInt(totalClaimableWei),
    };
  },
});

module.exports = {
  createChainReader,
  DEFAULT_TIMEOUT_MS,
  normalizeLog,
  serializeArgs,
  FACTORY_EVENTS,
  SPLIT_EVENTS,
  factoryAbi,
  splitAbi,
};
