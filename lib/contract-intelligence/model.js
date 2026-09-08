// lib/contract-intelligence/model.js
//
// Normalized domain model for Contract Intelligence, plus the pure functions
// that reconstruct a split's lifecycle from decoded event logs.
//
// Source-of-truth rules enforced here:
//   - CURRENT state (round, participant count, balances, version) comes from
//     live contract reads and is passed in as `reads`;
//   - HISTORICAL facts (joins, funding, finalization, withdrawals) come only
//     from decoded event logs. The deployment manifest is never consulted for
//     lifecycle facts — it supplies static scenario prose and nothing else.
//
// Participant addresses appear in this module because outstanding-claim counting
// requires matching allocations to withdrawals per address. They are held in
// local scope only: no snapshot field, no answer, and no evidence record ever
// carries one. `assertNoAddressLeak` in the test suite pins that.

const { SEPOLIA_EXPLORER } = require("./constants");

/**
 * @typedef {Object} ContractEventEvidence
 * @property {string} label            Human-readable description.
 * @property {string} type             Event name, or "ContractRead" for live state.
 * @property {number|null} blockNumber
 * @property {string|null} transactionHash
 * @property {string} etherscanUrl
 */

/**
 * @typedef {Object} SplitRoundSnapshot
 * @property {number} round
 * @property {number} joinCount                 Joins observed for this round.
 * @property {bigint} fundedWei                 Sum of Funded amounts for this round.
 * @property {boolean} finalized
 * @property {bigint} totalDistributedWei
 * @property {bigint} amountPerParticipantWei
 * @property {number} finalizedParticipantCount Count reported by the contract.
 * @property {bigint} remainderWei              Dust carried to the next round.
 * @property {ContractEventEvidence[]} evidence
 */

/**
 * @typedef {Object} SplitSnapshot
 * @property {string} address
 * @property {string} title
 * @property {string} version
 * @property {number} currentRound
 * @property {number} currentParticipantCount
 * @property {bigint} balanceWei
 * @property {bigint} roundPoolWei
 * @property {bigint} totalClaimableWei
 * @property {number|null} createdAtBlock
 * @property {string|null} creationTxHash
 * @property {SplitRoundSnapshot[]} rounds
 * @property {number} withdrawalCount
 * @property {bigint} withdrawnTotalWei
 * @property {number} outstandingClaimCount
 * @property {string} lifecycleState
 * @property {string[]} badges
 * @property {boolean} historyComplete
 * @property {ContractEventEvidence[]} evidence
 */

/**
 * @typedef {Object} FactorySnapshot
 * @property {string} address
 * @property {string} version
 * @property {number} deployedSplitCount
 * @property {number} deploymentBlock
 * @property {number} generatedAtBlock
 * @property {SplitSnapshot[]} splits
 * @property {boolean} historyComplete
 * @property {string[]} warnings
 */

const LIFECYCLE = {
  FRESH: "fresh",
  ROUND_OPEN: "round-open",
  AWAITING_FUNDING: "awaiting-funding",
  AWAITING_DISTRIBUTION: "awaiting-distribution",
  FINALIZED: "finalized",
  CLAIMS_OUTSTANDING: "claims-outstanding",
};

const addressUrl = (address) => `${SEPOLIA_EXPLORER}/address/${address}`;
const txUrl = (hash) => `${SEPOLIA_EXPLORER}/tx/${hash}`;

/** Builds one evidence record from a decoded log. */
const evidenceFromLog = (log, label) => ({
  label,
  type: log.eventName,
  blockNumber: log.blockNumber,
  transactionHash: log.transactionHash,
  etherscanUrl: txUrl(log.transactionHash),
});

/** Evidence for a value that came from a live contract read, not an event. */
const evidenceFromRead = (label, address, blockNumber) => ({
  label,
  type: "ContractRead",
  blockNumber,
  transactionHash: null,
  etherscanUrl: addressUrl(address),
});

/**
 * Evidence for current-state values reconstructed from indexed events.
 *
 * Deliberately NOT typed "ContractRead". Citing a contract read that never
 * happened is the kind of quiet dishonesty this whole module exists to avoid:
 * the reader is entitled to know that these figures were computed from event
 * history, not observed on chain.
 */
const evidenceFromDerivation = (label, address) => ({
  label,
  type: "IndexedEvents",
  blockNumber: null,
  transactionHash: null,
  etherscanUrl: addressUrl(address),
});

const byBlockThenLog = (a, b) =>
  a.blockNumber - b.blockNumber || (a.logIndex || 0) - (b.logIndex || 0);

/**
 * Reconstructs a split's lifecycle from live reads plus decoded event logs.
 *
 * @param {Object} input
 * @param {Object} input.reads     Current-state values.
 * @param {Object} input.events    Decoded logs: {joined, funded, finalized, withdrawn}.
 * @param {Object} [input.creation] The SplitCreated log for this split.
 * @param {number} input.atBlock   Block the reads were taken at.
 * @param {boolean} [input.historyComplete=true]
 * @param {string} [input.currentStateSource="live"] Where `reads` came from:
 *   "live"            a contract read that succeeded now;
 *   "last-known-good" a contract read that succeeded earlier and has not been
 *                     refreshed — real, but not current;
 *   "derived"         reconstructed from indexed events; no read happened.
 * @param {number} [input.currentStateAtBlock] Block the reads were actually
 *   taken at, when that differs from `atBlock` (a stale last-known-good read).
 * @returns {SplitSnapshot}
 */
const buildSplitSnapshot = ({
  reads,
  events,
  creation = null,
  atBlock,
  historyComplete = true,
  currentStateSource = "live",
  currentStateAtBlock = null,
}) => {
  const joined = [...(events.joined || [])].sort(byBlockThenLog);
  const funded = [...(events.funded || [])].sort(byBlockThenLog);
  const finalized = [...(events.finalized || [])].sort(byBlockThenLog);
  const withdrawn = [...(events.withdrawn || [])].sort(byBlockThenLog);

  // ---- per-round reconstruction, entirely from events ----
  const roundNumbers = new Set();
  joined.forEach((log) => roundNumbers.add(Number(log.args.round)));
  funded.forEach((log) => roundNumbers.add(Number(log.args.round)));
  finalized.forEach((log) => roundNumbers.add(Number(log.args.round)));

  const rounds = [...roundNumbers]
    .sort((a, b) => a - b)
    .map((round) => {
      const roundJoins = joined.filter((log) => Number(log.args.round) === round);
      const roundFunding = funded.filter(
        (log) => Number(log.args.round) === round
      );
      const roundFinal = finalized.find(
        (log) => Number(log.args.round) === round
      );

      const evidence = [];

      if (roundJoins.length > 0) {
        evidence.push(
          evidenceFromLog(
            roundJoins[roundJoins.length - 1],
            `${roundJoins.length} participant${
              roundJoins.length === 1 ? "" : "s"
            } joined round ${round}`
          )
        );
      }

      roundFunding.forEach((log) =>
        evidence.push(evidenceFromLog(log, `Round ${round} funded`))
      );

      if (roundFinal) {
        evidence.push(
          evidenceFromLog(roundFinal, `Round ${round} distribution finalized`)
        );
      }

      return {
        round,
        joinCount: roundJoins.length,
        fundedWei: roundFunding.reduce(
          (sum, log) => sum + BigInt(log.args.amount),
          0n
        ),
        finalized: Boolean(roundFinal),
        totalDistributedWei: roundFinal
          ? BigInt(roundFinal.args.totalDistributed)
          : 0n,
        amountPerParticipantWei: roundFinal
          ? BigInt(roundFinal.args.amountPerParticipant)
          : 0n,
        finalizedParticipantCount: roundFinal
          ? Number(roundFinal.args.participantCount)
          : 0,
        remainderWei: roundFinal ? BigInt(roundFinal.args.remainderRemaining) : 0n,
        evidence,
      };
    });

  // ---- outstanding claims, from events only ----
  //
  // DistributionFinalized reports how much each participant received but not who
  // they were, so allocations are matched to the addresses that joined that
  // round. Withdrawal carries an address and an amount. The addresses live in
  // this local map and are deliberately discarded when it goes out of scope.
  const ledger = new Map();

  rounds
    .filter((round) => round.finalized)
    .forEach((round) => {
      joined
        .filter((log) => Number(log.args.round) === round.round)
        .forEach((log) => {
          const key = String(log.args.participant).toLowerCase();
          ledger.set(
            key,
            (ledger.get(key) || 0n) + round.amountPerParticipantWei
          );
        });
    });

  withdrawn.forEach((log) => {
    const key = String(log.args.participant).toLowerCase();
    ledger.set(key, (ledger.get(key) || 0n) - BigInt(log.args.amount));
  });

  const outstandingClaimCount = [...ledger.values()].filter(
    (amount) => amount > 0n
  ).length;

  const withdrawnTotalWei = withdrawn.reduce(
    (sum, log) => sum + BigInt(log.args.amount),
    0n
  );

  // ---- lifecycle state, from current reads plus reconstructed history ----
  const anyFinalized = rounds.some((round) => round.finalized);
  const currentParticipants = Number(reads.participantCount);
  const badges = [];
  let lifecycleState;

  if (anyFinalized) {
    lifecycleState = LIFECYCLE.FINALIZED;
    badges.push("Distribution Finalized");

    if (reads.totalClaimableWei > 0n) {
      lifecycleState = LIFECYCLE.CLAIMS_OUTSTANDING;
      badges.push("Claims Outstanding");
    }
  } else if (currentParticipants > 0 && reads.roundPoolWei > 0n) {
    lifecycleState = LIFECYCLE.AWAITING_DISTRIBUTION;
    badges.push("Round Open", "Awaiting Distribution");
  } else if (currentParticipants > 0) {
    lifecycleState = LIFECYCLE.AWAITING_FUNDING;
    badges.push("Round Open", "Awaiting Funding");
  } else if (joined.length === 0) {
    lifecycleState = LIFECYCLE.FRESH;
    badges.push("Round Open");
  } else {
    lifecycleState = LIFECYCLE.ROUND_OPEN;
    badges.push("Round Open");
  }

  const evidence = [];

  if (creation) {
    evidence.push(evidenceFromLog(creation, `${reads.title} created`));
  }

  // Only cite a contract read that actually happened.
  if (currentStateSource === "live") {
    evidence.push(
      evidenceFromRead(
        `Current state read at block ${atBlock}`,
        reads.address,
        atBlock
      )
    );
  } else if (currentStateSource === "last-known-good") {
    const readBlock = currentStateAtBlock || atBlock;

    evidence.push(
      evidenceFromRead(
        `Current state last read at block ${readBlock}; not refreshed since`,
        reads.address,
        readBlock
      )
    );
  } else {
    evidence.push(
      evidenceFromDerivation(
        "Current state reconstructed from indexed events; not read from the contract",
        reads.address
      )
    );
  }

  return {
    address: reads.address,
    title: reads.title,
    version: reads.version,
    currentRound: Number(reads.round),
    currentParticipantCount: currentParticipants,
    balanceWei: reads.balanceWei,
    roundPoolWei: reads.roundPoolWei,
    totalClaimableWei: reads.totalClaimableWei,
    createdAtBlock: creation ? creation.blockNumber : null,
    creationTxHash: creation ? creation.transactionHash : null,
    rounds,
    withdrawalCount: withdrawn.length,
    withdrawnTotalWei,
    outstandingClaimCount,
    lifecycleState,
    badges,
    historyComplete,
    currentStateSource,
    currentStateAtBlock: currentStateAtBlock || (currentStateSource === "live" ? atBlock : null),
    evidence,
  };
};

/**
 * Collapses per-split provenance into one honest label for the whole snapshot.
 *
 * Returns "live" only when every split was read live; "mixed" when some were
 * and some were not; otherwise the single source they share.
 */
const summarizeCurrentStateSource = (splits) => {
  if (!splits.length) {
    return "none";
  }

  const sources = new Set(
    splits.map((split) => split.currentStateSource || "live")
  );

  if (sources.size === 1) {
    return [...sources][0];
  }

  return "mixed";
};

/**
 * @param {Object} input
 * @returns {FactorySnapshot}
 */
const buildFactorySnapshot = ({
  address,
  version,
  deployedSplitCount,
  deploymentBlock,
  generatedAtBlock,
  splits,
  warnings = [],
}) => ({
  address,
  version,
  deployedSplitCount,
  deploymentBlock,
  generatedAtBlock,
  splits,
  historyComplete: splits.every((split) => split.historyComplete),
  // "live" only when EVERY split was read live. One failed split makes the
  // snapshot mixed, never live.
  currentStateSource: summarizeCurrentStateSource(splits),
  warnings,
});

module.exports = {
  LIFECYCLE,
  addressUrl,
  summarizeCurrentStateSource,
  txUrl,
  evidenceFromLog,
  evidenceFromRead,
  buildSplitSnapshot,
  buildFactorySnapshot,
};
