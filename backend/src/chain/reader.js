// backend/src/chain/reader.js
//
// All Sepolia RPC access lives here. This is the code that used to run in the
// visitor's browser in Milestone 2; moving it server-side is the point of this
// milestone.
//
// It does no database work and holds no Prisma import, so it can be unit-tested
// against a stub provider.

const path = require("path");

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
const fetchLogs = async ({ contract, address, eventNames, fromBlock, toBlock }) => {
  const rows = [];

  for (const eventName of eventNames) {
    const logs = await contract.queryFilter(
      contract.filters[eventName](),
      fromBlock,
      toBlock
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

/**
 * Creates the chain reader.
 *
 * @param {Object} input
 * @param {Object} input.provider        ethers Provider (or a stub in tests).
 * @param {Function} input.createContract (address, abi) => contract.
 */
const createChainReader = ({ provider, createContract }) => ({
  factoryAbi,
  splitAbi,

  async getBlockNumber() {
    return provider.getBlockNumber();
  },

  async getBlock(blockNumber) {
    return provider.getBlock(blockNumber);
  },

  /** Confirmed head: the newest block deep enough to be safe to index. */
  async getConfirmedHead(confirmations) {
    const head = await provider.getBlockNumber();
    return Math.max(0, head - confirmations);
  },

  async getFactoryInfo(address) {
    const factory = createContract(address, factoryAbi);
    const [version, deployedSplits] = await factory.getFactoryInfo();

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
    });
  },

  async fetchSplitLogs(address, fromBlock, toBlock) {
    return fetchLogs({
      contract: createContract(address, splitAbi),
      address,
      eventNames: SPLIT_EVENTS,
      fromBlock,
      toBlock,
    });
  },

  /** Current on-chain state of one split. Reads, never events. */
  async readSplitState(address) {
    const split = createContract(address, splitAbi);

    const [
      title,
      version,
      round,
      participantCount,
      balanceWei,
      roundPoolWei,
      totalClaimableWei,
    ] = await Promise.all([
      split.title(),
      split.VERSION(),
      split.round(),
      split.participantCount(),
      split.contractBalance(),
      split.availableForDistribution(),
      split.totalClaimable(),
    ]);

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
  normalizeLog,
  serializeArgs,
  FACTORY_EVENTS,
  SPLIT_EVENTS,
  factoryAbi,
  splitAbi,
};
