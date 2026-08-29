// backend/src/indexer/indexer.js
//
// Restart-safe, chunked, confirmation-delayed indexer with conservative reorg
// handling.
//
// Guarantees:
//   - starts from the factory deployment block on an empty database;
//   - never indexes closer to the head than `confirmations` blocks;
//   - processes logs in bounded chunks, so one eth_getLogs is never unbounded;
//   - writes events and the checkpoint in a single transaction, so a crash
//     mid-chunk cannot advance the cursor past unwritten events;
//   - is idempotent: a duplicated log collides on
//     (chainId, transactionHash, logIndex) and is skipped.
//
// Reorg handling — read this before trusting it:
//   Before extending the cursor, the stored checkpoint block hash is re-read
//   from the RPC. If it no longer matches, the indexer deletes every event in
//   the last `reorgDepth` blocks, rewinds the cursor by the same amount, and
//   replays. That is a conservative window strategy, NOT full ancestry walking.
//   It handles the shallow reorgs a testnet demo realistically sees. A reorg
//   deeper than `reorgDepth` would leave stale rows, and the honest remedy for
//   that is `indexer:rebuild`. Documented in DEPLOYMENT.md rather than dressed
//   up as enterprise-grade.

const { LIFECYCLE_EVENTS } = require("./projection");

const lower = (value) => String(value).toLowerCase();

/** Splits [from, to] into inclusive chunks of at most `size` blocks. */
const chunkRanges = (fromBlock, toBlock, size) => {
  const ranges = [];

  for (let start = fromBlock; start <= toBlock; start += size) {
    ranges.push({
      fromBlock: start,
      toBlock: Math.min(start + size - 1, toBlock),
    });
  }

  return ranges;
};

const createIndexer = ({ prisma, reader, config, logger = console }) => {
  const { chainId, factoryAddress, deploymentBlock } = config;
  const { confirmations, chunkSize, reorgDepth } = config.indexer;

  /** Ensures the Factory row exists and returns it. */
  const ensureFactory = async () => {
    const address = lower(factoryAddress);

    const existing = await prisma.factory.findUnique({
      where: { chainId_address: { chainId, address } },
    });

    if (existing) {
      return existing;
    }

    return prisma.factory.create({
      data: {
        chainId,
        address,
        deploymentBlock,
        version: config.factoryVersion || null,
      },
    });
  };

  /**
   * Restricts a ChainEvent query to one factory.
   *
   * Scoping by chainId alone would reach events belonging to a DIFFERENT
   * factory on the same chain — so a rollback or rebuild for this deployment
   * would silently destroy another one's index.
   */
  const factoryScope = async (factoryId) => {
    const splits = await prisma.split.findMany({
      where: { factoryId },
      select: { id: true },
    });

    return {
      chainId,
      OR: [
        { address: lower(factoryAddress) },
        { splitId: { in: splits.map((split) => split.id) } },
      ],
    };
  };

  const getCheckpoint = async (factoryId) =>
    prisma.indexerCheckpoint.findUnique({
      where: {
        chainId_factoryId_stream: { chainId, factoryId, stream: "main" },
      },
    });

  const ensureCheckpoint = async (factoryId) => {
    const existing = await getCheckpoint(factoryId);

    if (existing) {
      return existing;
    }

    // An empty database starts one block BEFORE the deployment block, so the
    // first pass includes the deployment block itself.
    return prisma.indexerCheckpoint.create({
      data: {
        chainId,
        factoryId,
        stream: "main",
        lastIndexedBlock: deploymentBlock - 1,
        lastIndexedHash: null,
      },
    });
  };

  /**
   * Conservative reorg check: does the block we last indexed still hash the
   * same on chain?
   */
  const detectReorg = async (checkpoint) => {
    if (!checkpoint.lastIndexedHash) {
      return false;
    }

    const block = await reader.getBlock(checkpoint.lastIndexedBlock);

    if (!block) {
      return true;
    }

    return lower(block.hash) !== lower(checkpoint.lastIndexedHash);
  };

  /** Rolls back a window of blocks and rewinds the cursor to replay them. */
  const rollback = async (factory, checkpoint) => {
    const rewindTo = Math.max(
      deploymentBlock - 1,
      checkpoint.lastIndexedBlock - reorgDepth
    );

    logger.warn(
      `[indexer] reorg detected at block ${checkpoint.lastIndexedBlock}; ` +
        `rolling back to ${rewindTo}`
    );

    const scope = await factoryScope(factory.id);

       await prisma.$transaction(async (tx) => {
      await tx.chainEvent.deleteMany({
        where: { ...scope, blockNumber: { gt: rewindTo } },
      });

      // Split rows are discovered from SplitCreated events. If that creation
      // event belonged to the reverted window, the row must disappear too.
      // Valid splits created before the rewind point remain untouched.
      await tx.split.deleteMany({
        where: {
          factoryId: factory.id,
          createdAtBlock: { gt: rewindTo },
        },
      });

      const rewindBlock = await reader.getBlock(rewindTo);

      await tx.indexerCheckpoint.update({
        where: { id: checkpoint.id },
        data: {
          lastIndexedBlock: rewindTo,
          lastIndexedHash: rewindBlock ? rewindBlock.hash : null,
          reorgCount: { increment: 1 },
        },
      });
    });

    // Projections are derived, so they are simply rebuilt from what remains.
    await rebuildProjections(factory.id);

    return rewindTo;
  };

  /** Upserts split rows discovered from SplitCreated logs. */
  const upsertSplitsFromLogs = async (factory, logs) => {
    const created = logs.filter((log) => log.eventName === "SplitCreated");

    for (const log of created) {
      const address = lower(log.args.splitAddress);

      await prisma.split.upsert({
        where: { chainId_address: { chainId, address } },
        create: {
          factoryId: factory.id,
          chainId,
          address,
          title: log.args.title,
          manager: lower(log.args.manager),
          factoryIndex: Number.parseInt(log.args.index, 10),
          createdAtBlock: log.blockNumber,
          createdAtTx: log.transactionHash,
          createdAt: log.args.createdAtTimestamp
            ? new Date(Number.parseInt(log.args.createdAtTimestamp, 10) * 1000)
            : null,
        },
        update: {},
      });
    }
  };

  /** Persists a batch of normalized logs idempotently. */
  const persistEvents = async (tx, rows, splitIdByAddress) => {
    let written = 0;

    for (const row of rows) {
      const result = await tx.chainEvent.createMany({
        data: [
          {
            chainId,
            address: row.address,
            splitId: splitIdByAddress.get(row.address) || null,
            eventName: row.eventName,
            blockNumber: row.blockNumber,
            blockHash: row.blockHash,
            transactionHash: row.transactionHash,
            logIndex: row.logIndex,
            blockTimestamp: row.blockTimestamp || null,
            args: row.args,
            round: row.round,
            amount: row.amount,
          },
        ],
        // The unique key absorbs duplicate deliveries and replays.
        skipDuplicates: true,
      });

      written += result.count;
    }

    return written;
  };

  /** Rebuilds SplitRound rows for one factory from persisted events. */
  const rebuildProjections = async (factoryId) => {
    const splits = await prisma.split.findMany({ where: { factoryId } });

    for (const split of splits) {
      const events = await prisma.chainEvent.findMany({
        where: { splitId: split.id, eventName: { in: LIFECYCLE_EVENTS } },
        orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
      });

      const rounds = new Map();

      const roundOf = (number) => {
        if (!rounds.has(number)) {
          rounds.set(number, {
            round: number,
            joinCount: 0,
            fundedWei: 0n,
            finalized: false,
            finalizedAtBlock: null,
            finalizedTx: null,
            totalDistributedWei: 0n,
            amountPerParticipantWei: 0n,
            finalizedParticipantCount: 0,
            remainderWei: 0n,
            firstBlock: null,
            lastBlock: null,
          });
        }

        return rounds.get(number);
      };

      events.forEach((event) => {
        if (event.round === null) {
          return;
        }

        const entry = roundOf(event.round);

        entry.firstBlock =
          entry.firstBlock === null
            ? event.blockNumber
            : Math.min(entry.firstBlock, event.blockNumber);
        entry.lastBlock =
          entry.lastBlock === null
            ? event.blockNumber
            : Math.max(entry.lastBlock, event.blockNumber);

        if (event.eventName === "ParticipantJoined") {
          entry.joinCount += 1;
        }

        if (event.eventName === "Funded") {
          entry.fundedWei += BigInt(event.args.amount);
        }

        if (event.eventName === "DistributionFinalized") {
          entry.finalized = true;
          entry.finalizedAtBlock = event.blockNumber;
          entry.finalizedTx = event.transactionHash;
          entry.totalDistributedWei = BigInt(event.args.totalDistributed);
          entry.amountPerParticipantWei = BigInt(event.args.amountPerParticipant);
          entry.finalizedParticipantCount = Number.parseInt(
            event.args.participantCount,
            10
          );
          entry.remainderWei = BigInt(event.args.remainderRemaining);
        }
      });

      // Drop rounds that no longer exist (possible after a reorg rollback).
      await prisma.splitRound.deleteMany({
        where: {
          splitId: split.id,
          round: { notIn: [...rounds.keys()] },
        },
      });

      for (const entry of rounds.values()) {
        const data = {
          joinCount: entry.joinCount,
          fundedWei: entry.fundedWei.toString(),
          finalized: entry.finalized,
          finalizedAtBlock: entry.finalizedAtBlock,
          finalizedTx: entry.finalizedTx,
          totalDistributedWei: entry.totalDistributedWei.toString(),
          amountPerParticipantWei: entry.amountPerParticipantWei.toString(),
          finalizedParticipantCount: entry.finalizedParticipantCount,
          remainderWei: entry.remainderWei.toString(),
          firstBlock: entry.firstBlock,
          lastBlock: entry.lastBlock,
        };

        await prisma.splitRound.upsert({
          where: { splitId_round: { splitId: split.id, round: entry.round } },
          create: { splitId: split.id, round: entry.round, ...data },
          update: data,
        });
      }
    }
  };

  /**
   * Runs one indexing pass up to the confirmed head.
   * @returns {Promise<{from:number,to:number,events:number,reorg:boolean,upToDate:boolean}>}
   */
  const sync = async () => {
    const factory = await ensureFactory();
    let checkpoint = await ensureCheckpoint(factory.id);

    await prisma.indexerCheckpoint.update({
      where: { id: checkpoint.id },
      data: { lastSyncStartedAt: new Date(), lastError: null },
    });

    let reorg = false;

    if (await detectReorg(checkpoint)) {
      reorg = true;
      await rollback(factory, checkpoint);
      checkpoint = await getCheckpoint(factory.id);
    }

    const confirmedHead = await reader.getConfirmedHead(confirmations);
    const fromBlock = checkpoint.lastIndexedBlock + 1;

    if (fromBlock > confirmedHead) {
      await prisma.indexerCheckpoint.update({
        where: { id: checkpoint.id },
        data: { lastSyncCompletedAt: new Date() },
      });

      return {
        from: fromBlock,
        to: confirmedHead,
        events: 0,
        reorg,
        upToDate: true,
      };
    }

    let totalWritten = 0;

    for (const range of chunkRanges(fromBlock, confirmedHead, chunkSize)) {
      // Factory logs first: they reveal splits whose logs we then need.
      const factoryLogs = await reader.fetchFactoryLogs(
        lower(factoryAddress),
        range.fromBlock,
        range.toBlock
      );

      await upsertSplitsFromLogs(factory, factoryLogs);

      const splits = await prisma.split.findMany({
        where: { factoryId: factory.id },
      });

      const splitIdByAddress = new Map(
        splits.map((split) => [split.address, split.id])
      );

      let splitLogs = [];

      for (const split of splits) {
        const logs = await reader.fetchSplitLogs(
          split.address,
          range.fromBlock,
          range.toBlock
        );
        splitLogs = splitLogs.concat(logs);
      }

      const rows = [...factoryLogs, ...splitLogs];
      const endBlock = await reader.getBlock(range.toBlock);

      // Events and cursor advance together: a crash between them is impossible.
      const written = await prisma.$transaction(async (tx) => {
        const count = await persistEvents(tx, rows, splitIdByAddress);

        await tx.indexerCheckpoint.update({
          where: { id: checkpoint.id },
          data: {
            lastIndexedBlock: range.toBlock,
            lastIndexedHash: endBlock ? endBlock.hash : null,
            eventsIndexed: { increment: count },
          },
        });

        return count;
      });

      totalWritten += written;

      logger.info(
        `[indexer] blocks ${range.fromBlock}-${range.toBlock}: ${written} new event(s)`
      );
    }

    await rebuildProjections(factory.id);

    await prisma.indexerCheckpoint.update({
      where: { id: checkpoint.id },
      data: { lastSyncCompletedAt: new Date() },
    });

    return {
      from: fromBlock,
      to: confirmedHead,
      events: totalWritten,
      reorg,
      upToDate: false,
    };
  };

  /** Reports cursor and health without touching the chain beyond the head. */
  const status = async () => {
    const factory = await prisma.factory.findUnique({
      where: { chainId_address: { chainId, address: lower(factoryAddress) } },
    });

    if (!factory) {
      return {
        initialized: false,
        chainId,
        factoryAddress: lower(factoryAddress),
        deploymentBlock,
      };
    }

    const [checkpoint, splitCount, eventCount] = await Promise.all([
      getCheckpoint(factory.id),
      prisma.split.count({ where: { factoryId: factory.id } }),
      prisma.chainEvent.count({ where: await factoryScope(factory.id) }),
    ]);

    return {
      initialized: true,
      chainId,
      factoryAddress: factory.address,
      deploymentBlock,
      lastIndexedBlock: checkpoint ? checkpoint.lastIndexedBlock : null,
      lastIndexedHash: checkpoint ? checkpoint.lastIndexedHash : null,
      lastSyncStartedAt: checkpoint ? checkpoint.lastSyncStartedAt : null,
      lastSyncCompletedAt: checkpoint ? checkpoint.lastSyncCompletedAt : null,
      lastError: checkpoint ? checkpoint.lastError : null,
      reorgCount: checkpoint ? checkpoint.reorgCount : 0,
      splitCount,
      eventCount,
    };
  };

  /** Destructive. Guarded by the CLI, never called implicitly. */
  const rebuild = async () => {
    const factory = await prisma.factory.findUnique({
      where: { chainId_address: { chainId, address: lower(factoryAddress) } },
    });

    if (factory) {
      const scope = await factoryScope(factory.id);

      await prisma.$transaction([
        prisma.chainEvent.deleteMany({ where: scope }),
        prisma.splitRound.deleteMany({
          where: { split: { factoryId: factory.id } },
        }),
        prisma.split.deleteMany({ where: { factoryId: factory.id } }),
        prisma.indexerCheckpoint.deleteMany({
          where: { chainId, factoryId: factory.id },
        }),
      ]);
    }

    return sync();
  };

  const recordError = async (error) => {
    const factory = await prisma.factory.findUnique({
      where: { chainId_address: { chainId, address: lower(factoryAddress) } },
    });

    if (!factory) {
      return;
    }

    const checkpoint = await getCheckpoint(factory.id);

    if (checkpoint) {
      await prisma.indexerCheckpoint.update({
        where: { id: checkpoint.id },
        data: { lastError: String(error.message || error).slice(0, 1000) },
      });
    }
  };

  return {
    sync,
    status,
    rebuild,
    recordError,
    rebuildProjections,
    ensureFactory,
    chunkRanges,
  };
};

module.exports = { createIndexer, chunkRanges };
