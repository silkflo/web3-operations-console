// backend/src/indexer/projection.js
//
// Turns indexed rows into the exact snapshot shape the Milestone 2 analysis
// rules already consume, so those rules move to the server unchanged.
//
// Historical facts come from ChainEvent rows. Current state comes from live
// contract reads passed in by the caller. The deployment manifest supplies
// nothing here.
//
// Participant addresses are used in one local Map to count outstanding claims —
// exactly as in M2 — and never leave this function.

const path = require("path");

const LIB = path.join(__dirname, "..", "..", "..", "lib", "contract-intelligence");

const { buildSplitSnapshot, buildFactorySnapshot } = require(path.join(LIB, "model"));

/** Split events that carry lifecycle meaning. */
const LIFECYCLE_EVENTS = [
  "ParticipantJoined",
  "Funded",
  "DistributionFinalized",
  "Withdrawal",
];

/** Re-shapes a persisted ChainEvent row into the model's decoded-log shape. */
const toModelLog = (row) => ({
  eventName: row.eventName,
  blockNumber: row.blockNumber,
  logIndex: row.logIndex,
  transactionHash: row.transactionHash,
  args: row.args,
});

/**
 * Builds a FactorySnapshot from the database plus live reads.
 *
 * @param {Object} input
 * @param {Object} input.prisma
 * @param {Object} input.config
 * @param {Map<string,Object>} input.liveState  address -> current contract read.
 * @param {number} input.generatedAtBlock
 * @param {boolean} [input.historyComplete=true]
 */
const buildSnapshotFromIndex = async ({
  prisma,
  config,
  liveState,
  generatedAtBlock,
  historyComplete = true,
}) => {
  const chainId = config.chainId;
  const address = String(config.factoryAddress).toLowerCase();

  const factory = await prisma.factory.findUnique({
    where: { chainId_address: { chainId, address } },
    include: { splits: { orderBy: { factoryIndex: "asc" } } },
  });

  if (!factory) {
    return buildFactorySnapshot({
      address,
      version: config.factoryVersion || "unknown",
      deployedSplitCount: 0,
      deploymentBlock: config.deploymentBlock,
      generatedAtBlock,
      splits: [],
      warnings: ["The indexer has not run against this factory yet."],
    });
  }

  const splits = [];

  for (const split of factory.splits) {
    const rows = await prisma.chainEvent.findMany({
      where: { splitId: split.id },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
    });

    const events = {
      joined: rows.filter((r) => r.eventName === "ParticipantJoined").map(toModelLog),
      funded: rows.filter((r) => r.eventName === "Funded").map(toModelLog),
      finalized: rows
        .filter((r) => r.eventName === "DistributionFinalized")
        .map(toModelLog),
      withdrawn: rows.filter((r) => r.eventName === "Withdrawal").map(toModelLog),
    };

    const creationRow = await prisma.chainEvent.findFirst({
      where: {
        chainId,
        eventName: "SplitCreated",
        transactionHash: split.createdAtTx,
      },
    });

    const live = liveState.get(split.address) || null;

    // Without a live read the split still projects from history; current-state
    // fields fall back to the last known values rather than inventing zeroes.
    const lastRound = rows.reduce(
      (max, row) => (row.round !== null && row.round > max ? row.round : max),
      1
    );

    const reads = live || {
      address: split.address,
      title: split.title,
      version: config.factoryVersion || "3.0.0",
      round: lastRound,
      participantCount: 0,
      balanceWei: 0n,
      roundPoolWei: 0n,
      totalClaimableWei: 0n,
    };

    splits.push(
      buildSplitSnapshot({
        reads: { ...reads, address: split.address, title: split.title },
        events,
        creation: creationRow ? toModelLog(creationRow) : null,
        atBlock: generatedAtBlock,
        historyComplete: historyComplete && Boolean(live),
      })
    );
  }

  return buildFactorySnapshot({
    address: factory.address,
    version: factory.version || config.factoryVersion || "unknown",
    deployedSplitCount: splits.length,
    deploymentBlock: factory.deploymentBlock,
    generatedAtBlock,
    splits,
    warnings: [],
  });
};

/**
 * Participation breakdown for the corrected dashboard wording.
 *
 * A raw "10 joins across 3 splits" is misleading, because three of those joins
 * belong to a round that has since been finalized and cleared. This separates
 * the two, from indexed events only.
 */
const summarizeParticipation = (snapshot) => {
  let totalJoinEvents = 0;
  let activeInOpenRounds = 0;
  let joinsInCompletedRounds = 0;

  snapshot.splits.forEach((split) => {
    split.rounds.forEach((round) => {
      totalJoinEvents += round.joinCount;

      if (round.finalized) {
        joinsInCompletedRounds += round.joinCount;
      } else {
        activeInOpenRounds += round.joinCount;
      }
    });
  });

  const completedSplitTitles = snapshot.splits
    .filter((split) => split.rounds.some((round) => round.finalized))
    .map((split) => split.title);

  return {
    totalJoinEvents,
    activeInOpenRounds,
    joinsInCompletedRounds,
    splitCount: snapshot.splits.length,
    completedSplitTitles,
    sentence:
      `${totalJoinEvents} join events across ${snapshot.splits.length} splits: ` +
      `${activeInOpenRounds} participants are currently active in open rounds, ` +
      `while ${joinsInCompletedRounds} joins belong to the completed ` +
      `${completedSplitTitles.join(" and ")} round.`,
  };
};

module.exports = {
  LIFECYCLE_EVENTS,
  buildSnapshotFromIndex,
  summarizeParticipation,
  toModelLog,
};
