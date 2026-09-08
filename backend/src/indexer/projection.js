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

/**
 * Reconstructs a split's CURRENT state from its indexed event history.
 *
 * Used only when no contract read is available. It replaces the previous
 * behaviour, which substituted zeroes for every current-state field and then
 * published them under "ContractRead" evidence — inventing a balance of 0 ETH
 * for a funded contract and citing a read that never happened.
 *
 * The reconstruction is exact for EthSplit v3, and it is exact because of what
 * the contract does NOT have: there is no `receive()` and no `fallback()`, so
 * `fund()` is the only way ETH enters, and every path that moves ETH or changes
 * participation emits an event.
 *
 *   round            1 at construction, incremented by each finalization
 *   participantCount joins in the current round (finalization clears the list)
 *   roundPool        total funded minus total distributed (the division
 *                    remainder stays in the pool and carries forward)
 *   totalClaimable   total distributed minus total withdrawn
 *   balance          total funded minus total withdrawn
 *
 * The one thing it cannot see is ETH forced in by `selfdestruct`, which no
 * event records. That would make the derived balance an understatement, which
 * is why these values are labelled "derived" and never presented as a read.
 */
const deriveCurrentStateFromEvents = (rows) => {
  const sum = (eventName, key) =>
    rows
      .filter((row) => row.eventName === eventName)
      .reduce((total, row) => total + BigInt(row.args[key] || 0), 0n);

  const finalizations = rows.filter(
    (row) => row.eventName === "DistributionFinalized"
  );

  const round = 1 + finalizations.length;

  const participantCount = rows.filter(
    (row) => row.eventName === "ParticipantJoined" && Number(row.round) === round
  ).length;

  const fundedTotal = sum("Funded", "amount");
  const distributedTotal = sum("DistributionFinalized", "totalDistributed");
  const withdrawnTotal = sum("Withdrawal", "amount");

  return {
    round,
    participantCount,
    roundPoolWei: fundedTotal - distributedTotal,
    totalClaimableWei: distributedTotal - withdrawnTotal,
    balanceWei: fundedTotal - withdrawnTotal,
  };
};

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
 *   An entry may carry `{ source, readAtBlock }` describing whether the read
 *   happened now ("live") or earlier ("last-known-good"). A missing entry means
 *   no read is available and current state is reconstructed from events.
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

    const entry = liveState.get(split.address) || null;

    // An entry may be a plain read (from the chain reader) or a wrapper
    // carrying provenance. Both are accepted so the projection stays usable
    // from tests and from the CLI without a snapshot service.
    const live = entry && entry.reads ? entry.reads : entry;
    const source = entry
      ? (entry.source || "live")
      : "derived";
    const readAtBlock = entry ? entry.readAtBlock || null : null;

    // No read available: reconstruct current state from what the chain
    // actually told us, and label it. Never substitute zeroes.
    const reads = live || {
      address: split.address,
      title: split.title,
      version: config.factoryVersion || "3.0.0",
      ...deriveCurrentStateFromEvents(rows),
    };

    splits.push(
      buildSplitSnapshot({
        reads: { ...reads, address: split.address, title: split.title },
        events,
        creation: creationRow ? toModelLog(creationRow) : null,
        atBlock: generatedAtBlock,
        // History is complete whenever the index covers it. It is unrelated to
        // whether a live read succeeded — conflating the two made an RPC blip
        // look like missing history.
        historyComplete,
        currentStateSource: source,
        currentStateAtBlock: readAtBlock,
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
  deriveCurrentStateFromEvents,
  buildSnapshotFromIndex,
  summarizeParticipation,
  toModelLog,
};
