// backend/test/indexer.test.js
//
// Indexer behaviour against a real PostgreSQL database and a stub chain.
//
// Uses the real database rather than a mock because the guarantees under test
// are database guarantees: the unique constraint that makes duplicate delivery
// a no-op, and the transaction that keeps events and the cursor in step.
//
// Skips cleanly when DATABASE_URL is unset, so `npm test` works on a machine
// with no Postgres.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createIndexer, chunkRanges } = require("../src/indexer/indexer");
const {
  createStubChain,
  stubConfig,
  FACTORY,
  SPLIT_A,
  DEPLOY_BLOCK,
} = require("./fixtures/chain");
const {
  createTestPrisma,
  truncateAll,
  skipReason,
} = require("./helpers/test-db");

// Every database test is skipped, not silently redirected, when no isolated
// test database is configured.
const skip = skipReason();

/**
 * Runs `fn` against a freshly truncated TEST database.
 *
 * The client comes from helpers/test-db.js, which pins the datasource to
 * DATABASE_URL_TEST. Nothing here can reach the development index: there is no
 * code path from this file to src/db/client.js.
 */
const withIndexer = async (fn, chainOptions) => {
  const prisma = createTestPrisma();
  const chain = createStubChain(chainOptions);
  const config = stubConfig();

  try {
    // Clean slate, so tests are order-independent and repeatable.
    await truncateAll(prisma);

    const indexer = createIndexer({
      prisma,
      reader: chain.reader,
      config,
      logger: { info() {}, warn() {}, error() {} },
    });

    await fn({ prisma, chain, config, indexer });
  } finally {
    await prisma.$disconnect();
  }
};

test("chunkRanges splits a span into bounded inclusive chunks", () => {
  assert.deepEqual(chunkRanges(1, 10, 4), [
    { fromBlock: 1, toBlock: 4 },
    { fromBlock: 5, toBlock: 8 },
    { fromBlock: 9, toBlock: 10 },
  ]);
});

test("chunkRanges never exceeds the requested size", () => {
  const ranges = chunkRanges(1000, 1999, 250);

  assert.equal(ranges.length, 4);
  ranges.forEach((range) => {
    assert.ok(range.toBlock - range.fromBlock + 1 <= 250);
  });
});

test("chunkRanges returns nothing when there is nothing to do", () => {
  assert.deepEqual(chunkRanges(100, 99, 50), []);
});

test(
  "indexes from the deployment block and discovers splits",
  { skip },
  async () => {
    await withIndexer(async ({ prisma, indexer, config }) => {
      const result = await indexer.sync();

      assert.equal(result.from, DEPLOY_BLOCK);
      assert.ok(result.events > 0);

      const splits = await prisma.split.findMany({
        where: { chainId: config.chainId, address: { in: [SPLIT_A] } },
      });
      assert.equal(splits.length, 1, "split A discovered from SplitCreated");

      const events = await prisma.chainEvent.count({
        where: { chainId: config.chainId, address: SPLIT_A },
      });
      // 3 joins + funded + finalized + withdrawal
      assert.equal(events, 6);
    });
  }
);

test(
  "is idempotent: a second sync writes nothing new",
  { skip },
  async () => {
    await withIndexer(async ({ indexer }) => {
      const first = await indexer.sync();
      const second = await indexer.sync();

      assert.ok(first.events > 0);
      assert.equal(second.events, 0, "no duplicates on re-run");
    });
  }
);

test(
  "absorbs duplicate log delivery from the RPC",
  { skip },
  async () => {
    await withIndexer(async ({ prisma, chain, indexer, config }) => {
      await indexer.sync();

      const before = await prisma.chainEvent.count({
        where: { chainId: config.chainId, address: SPLIT_A },
      });

      // Make the reader return every log twice, then rewind and replay.
      const original = chain.reader.fetchSplitLogs;
      chain.reader.fetchSplitLogs = async (...args) => {
        const rows = await original(...args);
        return [...rows, ...rows];
      };

      const factory = await prisma.factory.findUnique({
        where: { chainId_address: { chainId: config.chainId, address: FACTORY } },
      });

      await prisma.indexerCheckpoint.updateMany({
        where: { factoryId: factory.id },
        data: { lastIndexedBlock: DEPLOY_BLOCK - 1, lastIndexedHash: null },
      });

      await indexer.sync();

      const after = await prisma.chainEvent.count({
        where: { chainId: config.chainId, address: SPLIT_A },
      });

      assert.equal(after, before, "duplicate delivery must not double-count");
    });
  }
);

test(
  "resumes from the checkpoint after a restart",
  { skip },
  async () => {
    await withIndexer(async ({ prisma, chain, indexer, config }) => {
      await indexer.sync();

      const factory = await prisma.factory.findUnique({
        where: { chainId_address: { chainId: config.chainId, address: FACTORY } },
      });
      const checkpoint = await prisma.indexerCheckpoint.findFirst({
        where: { factoryId: factory.id },
      });

      const resumedFrom = checkpoint.lastIndexedBlock + 1;

      // A "restart" is a fresh indexer object over the same database.
      const restarted = createIndexer({
        prisma,
        reader: chain.reader,
        config,
        logger: { info() {}, warn() {}, error() {} },
      });

      chain.advance(20);
      const result = await restarted.sync();

      assert.equal(result.from, resumedFrom, "resumes where it stopped");
      assert.ok(!result.reorg);
    });
  }
);

test(
  "stops short of the confirmation depth",
  { skip },
  async () => {
    await withIndexer(async ({ indexer, chain, config }) => {
      const result = await indexer.sync();

      assert.equal(
        result.to,
        chain.state.head - config.indexer.confirmations,
        "never indexes closer to the head than the confirmation depth"
      );
    });
  }
);

test(
  "detects a reorg, rolls back and replays",
  { skip },
  async () => {
    await withIndexer(async ({ prisma, chain, indexer, config }) => {
      await indexer.sync();

      const factory = await prisma.factory.findUnique({
        where: { chainId_address: { chainId: config.chainId, address: FACTORY } },
      });

      const before = await prisma.indexerCheckpoint.findFirst({
        where: { factoryId: factory.id },
      });

      // Every block hash changes: the chain moved under us.
      chain.reorg("b");
      chain.advance(5);

      const result = await indexer.sync();

      assert.equal(result.reorg, true, "reorg detected");

      const after = await prisma.indexerCheckpoint.findFirst({
        where: { factoryId: factory.id },
      });

      assert.equal(after.reorgCount, before.reorgCount + 1);
      assert.equal(
        after.lastIndexedHash.slice(0, 4),
        "0xbb",
        "cursor now tracks the new fork"
      );

      // Replay must restore exactly the same events, not duplicate them.
      const events = await prisma.chainEvent.count({
        where: { chainId: config.chainId, address: SPLIT_A },
      });
      assert.equal(events, 6);
    });
  }
);

test(
  "removes a split whose creation event disappears in a reorg",
  { skip },
  async () => {
    await withIndexer(async ({ prisma, chain, indexer, config }) => {
      const orphanAddress =
        "0x0bad000000000000000000000000000000000002";
      const creationTransactionHash = `0x${"e1".repeat(32)}`;

      // Block 1090 is inside the indexer's eventual rollback window.
      chain.addLog(FACTORY, {
        eventName: "SplitCreated",
        blockNumber: 1090,
        logIndex: 0,
        transactionHash: creationTransactionHash,
        args: {
          splitAddress: orphanAddress,
          manager: "0xdead0000000000000000000000000000000000ff",
          title: "Reorged Split",
          index: "2",
          createdAtBlock: "1090",
          createdAtTimestamp: "1700000200",
        },
        round: null,
        amount: null,
      });

      await indexer.sync();

      const beforeReorg = await prisma.split.findUnique({
        where: {
          chainId_address: {
            chainId: config.chainId,
            address: orphanAddress,
          },
        },
      });

      assert.ok(beforeReorg, "split exists on the original fork");

      // The replacement fork has a different hash and no creation event.
      chain.removeLogs(
        FACTORY,
        (log) => log.transactionHash === creationTransactionHash
      );
      chain.reorg("c");
      chain.advance(5);

      const result = await indexer.sync();

      assert.equal(result.reorg, true, "replacement fork is detected");

      const afterReorg = await prisma.split.findUnique({
        where: {
          chainId_address: {
            chainId: config.chainId,
            address: orphanAddress,
          },
        },
      });

      assert.equal(
        afterReorg,
        null,
        "split created only on the reverted fork must be removed"
      );

      const staleCreationEvent = await prisma.chainEvent.findFirst({
        where: {
          chainId: config.chainId,
          transactionHash: creationTransactionHash,
        },
      });

      assert.equal(
        staleCreationEvent,
        null,
        "reverted SplitCreated event must also be removed"
      );
    });
  }
);


test(
  "projects rounds from indexed events",
  { skip },
  async () => {
    await withIndexer(async ({ prisma, indexer, config }) => {
      await indexer.sync();

      const split = await prisma.split.findUnique({
        where: { chainId_address: { chainId: config.chainId, address: SPLIT_A } },
      });

      const round = await prisma.splitRound.findUnique({
        where: { splitId_round: { splitId: split.id, round: 1 } },
      });

      assert.equal(round.joinCount, 3, "three joins in round 1");
      assert.equal(round.finalized, true);
      assert.equal(round.finalizedParticipantCount, 3);
      assert.equal(round.fundedWei.toString(), "1000000000000000");
      assert.equal(round.amountPerParticipantWei.toString(), "333333333333333");
      assert.equal(round.remainderWei.toString(), "1", "one wei of dust");
    });
  }
);

test(
  "rebuild clears and re-indexes to the same result",
  { skip },
  async () => {
    await withIndexer(async ({ prisma, indexer, config }) => {
      await indexer.sync();

      const before = await prisma.chainEvent.count({
        where: { chainId: config.chainId, address: SPLIT_A },
      });

      await indexer.rebuild();

      const after = await prisma.chainEvent.count({
        where: { chainId: config.chainId, address: SPLIT_A },
      });

      assert.equal(after, before, "rebuild is deterministic");
    });
  }
);

test(
  "status reports the cursor and counts",
  { skip },
  async () => {
    await withIndexer(async ({ indexer }) => {
      const before = await indexer.status();
      assert.equal(before.initialized, false);

      await indexer.sync();

      const after = await indexer.status();
      assert.equal(after.initialized, true);
      assert.equal(after.splitCount, 2);
      assert.ok(after.lastIndexedBlock >= DEPLOY_BLOCK);
      assert.ok(after.lastIndexedHash);
    });
  }
);
