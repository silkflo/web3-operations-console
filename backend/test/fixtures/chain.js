// backend/test/fixtures/chain.js
//
// A deterministic in-memory chain and a stub reader with the same surface as
// src/chain/reader.js. Lets the indexer be tested — including reorgs, which are
// impossible to trigger on demand against a real RPC.

const FACTORY = "0xfacc0000000000000000000000000000000000f1";
const SPLIT_A = "0x5a1100000000000000000000000000000000000a";
const SPLIT_B = "0x5b2200000000000000000000000000000000000b";

const DEPLOY_BLOCK = 1000;

/**
 * Distinctive participant addresses.
 *
 * Deliberately NOT built from repeated digits: an address like 0x1111…(40) is a
 * substring of a transaction hash like 0x1111…(64), which made the
 * address-leak test fire on its own fixture rather than on a real leak.
 */
const participantAddress = (n) => `0x${`c0de${n}`.padEnd(40, "0")}`;

const hashFor = (blockNumber, fork = "a") =>
  `0x${fork.repeat(2)}${String(blockNumber).padStart(62, "0")}`;

/**
 * Builds a stub chain.
 *
 * @param {Object} [options]
 * @param {number} [options.head]  Latest block number.
 * @param {string} [options.fork]  Changing this changes every block hash,
 *                                 which is how a reorg is simulated.
 */
const createStubChain = ({ head = 1100, fork = "a" } = {}) => {
  const state = { head, fork };

  /** Logs keyed by emitting address. */
  const logs = {
    [FACTORY]: [
      {
        eventName: "SplitCreated",
        blockNumber: 1010,
        logIndex: 0,
        transactionHash: `0x${"11".repeat(32)}`,
        args: {
          splitAddress: SPLIT_A,
          manager: "0xdead0000000000000000000000000000000000ff",
          title: "Creator Revenue Share",
          index: "0",
          createdAtBlock: "1010",
          createdAtTimestamp: "1700000000",
        },
        round: null,
        amount: null,
      },
      {
        eventName: "SplitCreated",
        blockNumber: 1020,
        logIndex: 0,
        transactionHash: `0x${"12".repeat(32)}`,
        args: {
          splitAddress: SPLIT_B,
          manager: "0xdead0000000000000000000000000000000000ff",
          title: "Product Team Bonus",
          index: "1",
          createdAtBlock: "1020",
          createdAtTimestamp: "1700000100",
        },
        round: null,
        amount: null,
      },
    ],

    // Split A runs the full lifecycle: 3 joins, funded, finalized, 1 withdrawal.
    [SPLIT_A]: [
      ...[1, 2, 3].map((n) => ({
        eventName: "ParticipantJoined",
        blockNumber: 1010 + n,
        logIndex: 0,
        transactionHash: `0x${String(20 + n).repeat(32)}`,
        args: {
          participant: participantAddress(n),
          round: "1",
          participantCount: String(n),
        },
        round: 1,
        amount: null,
      })),
      {
        eventName: "Funded",
        blockNumber: 1030,
        logIndex: 0,
        transactionHash: `0x${"31".repeat(32)}`,
        args: {
          manager: "0xdead0000000000000000000000000000000000ff",
          round: "1",
          amount: "1000000000000000",
          roundPoolTotal: "1000000000000000",
        },
        round: 1,
        amount: "1000000000000000",
      },
      {
        eventName: "DistributionFinalized",
        blockNumber: 1031,
        logIndex: 0,
        transactionHash: `0x${"32".repeat(32)}`,
        args: {
          round: "1",
          totalDistributed: "999999999999999",
          participantCount: "3",
          amountPerParticipant: "333333333333333",
          remainderRemaining: "1",
        },
        round: 1,
        amount: "999999999999999",
      },
      {
        eventName: "Withdrawal",
        blockNumber: 1032,
        logIndex: 0,
        transactionHash: `0x${"33".repeat(32)}`,
        args: {
          participant: participantAddress(1),
          amount: "333333333333333",
          remainingClaimable: "0",
        },
        round: null,
        amount: "333333333333333",
      },
    ],

    // Split B: joined but never funded.
    [SPLIT_B]: [1, 2, 3, 4].map((n) => ({
      eventName: "ParticipantJoined",
      blockNumber: 1020 + n,
      logIndex: 0,
      transactionHash: `0x${String(40 + n).repeat(32)}`,
      args: {
        participant: participantAddress(n),
        round: "1",
        participantCount: String(n),
      },
      round: 1,
      amount: null,
    })),
  };

  // Mirrors normalizeLog() in src/chain/reader.js: the real reader stamps the
  // emitting address and block hash onto every row, and the indexer requires
  // both. The fixture must produce the same shape or it tests a fiction.
  const inRange = (address, fromBlock, toBlock) =>
    (logs[address.toLowerCase()] || [])
      .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
      .map((log) => ({
        ...log,
        address: address.toLowerCase(),
        blockHash: hashFor(log.blockNumber, state.fork),
      }));

  // Counted so a test can assert how much RPC traffic a request actually costs.
  const calls = {
    fetchFactoryLogs: 0,
    fetchSplitLogs: 0,
    getBlock: 0,
    getBlockNumber: 0,
    readSplitState: 0,
  };

  const reader = {
    async getBlockNumber() {
      calls.getBlockNumber += 1;
      return state.head;
    },

    async getBlock(blockNumber) {
      calls.getBlock += 1;

      if (blockNumber > state.head) {
        return null;
      }

      return { number: blockNumber, hash: hashFor(blockNumber, state.fork) };
    },

    async getConfirmedHead(confirmations) {
      return Math.max(0, state.head - confirmations);
    },

    async fetchFactoryLogs(address, fromBlock, toBlock) {
      calls.fetchFactoryLogs += 1;
      return inRange(address, fromBlock, toBlock);
    },

    async fetchSplitLogs(address, fromBlock, toBlock) {
      calls.fetchSplitLogs += 1;
      return inRange(address, fromBlock, toBlock);
    },

    async readSplitState(address) {
      calls.readSplitState += 1;

      const isA = address.toLowerCase() === SPLIT_A;

      return {
        address,
        title: isA ? "Creator Revenue Share" : "Product Team Bonus",
        version: "3.0.0",
        round: isA ? 2 : 1,
        participantCount: isA ? 0 : 4,
        balanceWei: isA ? 666666666666667n : 0n,
        roundPoolWei: isA ? 1n : 0n,
        totalClaimableWei: isA ? 666666666666666n : 0n,
      };
    },
  };

    return {
    reader,
    calls,
    state,
    addresses: { FACTORY, SPLIT_A, SPLIT_B },
    deployBlock: DEPLOY_BLOCK,
    hashFor,

    /** Adds a log to the currently represented fork. Test-only helper. */
    addLog(address, log) {
      if (!logs[address]) {
        logs[address] = [];
      }

      logs[address].push(log);
    },

    /** Removes fork-specific logs when simulating a replacement chain. */
    removeLogs(address, predicate) {
      logs[address] = (logs[address] || []).filter(
        (log) => !predicate(log)
      );
    },

    /** Simulates a reorg: every block hash changes. */
    reorg(newFork = "b") {
      state.fork = newFork;
    },
    advance(blocks) {
      state.head += blocks;
    },
  };
};

const stubConfig = (overrides = {}) => ({
  chainId: 11155111,
  factoryAddress: FACTORY,
  deploymentBlock: DEPLOY_BLOCK,
  factoryVersion: "3.0.0",
  rpc: {
    timeoutMs: 1000,
    maxAttempts: 1,
  },
  indexer: {
    confirmations: 6,
    chunkSize: 50,
    minChunkSize: 5,
    pollMs: 15000,
    catchUpPollMs: 100,
    // Tests must not sit through real delays; the backoff itself is asserted
    // by injecting a `wait` spy rather than by waiting.
    chunkDelayMs: 0,
    maxBlocksPerPass: 0,
    rpcTimeoutMs: 1000,
    maxAttempts: 3,
    backoffMs: 10,
    backoffMaxMs: 100,
    reorgDepth: 24,
  },
  api: {
    host: "127.0.0.1",
    port: 4000,
    corsOrigins: ["http://localhost:3000"],
    rateLimitMax: 5,
    rateLimitWindow: "1 minute",
    staleAfterSeconds: 300,
    snapshotTtlSeconds: 60,
    snapshotMaxStaleSeconds: 900,
    chainHeadTtlSeconds: 15,
    rpcErrorCooldownSeconds: 30,
    healthTimeoutMs: 2000,
    logLevel: "silent",
  },
  ...overrides,
});

module.exports = {
  createStubChain,
  stubConfig,
  participantAddress,
  FACTORY,
  SPLIT_A,
  SPLIT_B,
  DEPLOY_BLOCK,
};
