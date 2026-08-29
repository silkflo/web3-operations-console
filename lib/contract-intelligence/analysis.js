// lib/contract-intelligence/analysis.js
//
// Deterministic analysis rules. Pure functions: FactorySnapshot in,
// IntelligenceAnswer out. No network, no randomness, no model, no I/O.
//
// Every fact carries a `source` of either "read" (live contract call) or
// "event" (decoded on-chain log), and every historical claim is accompanied by
// evidence pointing at the transaction that proves it.

const { addressUrl, txUrl, LIFECYCLE } = require("./model");
const { formatEthText, abbreviateAddress, numberWord, plural } = require("./format");

/**
 * @typedef {Object} IntelligenceFact
 * @property {string} label
 * @property {string} value
 * @property {"read"|"event"|"derived"} source
 */

/**
 * @typedef {Object} IntelligenceAnswer
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {"ok"|"partial"|"empty"} status
 * @property {IntelligenceFact[]} facts
 * @property {import("./model").ContractEventEvidence[]} evidence
 * @property {number} generatedAtBlock
 * @property {string|null} note
 */

const fact = (label, value, source) => ({ label, value, source });

const answer = ({
  id,
  title,
  summary,
  status = "ok",
  facts = [],
  evidence = [],
  generatedAtBlock,
  note = null,
}) => ({ id, title, summary, status, facts, evidence, generatedAtBlock, note });

/** Incomplete history must be disclosed, not silently smoothed over. */
const incompletenessNote = (snapshot) =>
  snapshot.historyComplete
    ? null
    : "Some event logs could not be read from the RPC endpoint, so parts of the history below may be incomplete.";

const statusFor = (snapshot, hasContent) => {
  if (!hasContent) return "empty";
  return snapshot.historyComplete ? "ok" : "partial";
};

// ============ 1. EXPLAIN THE FACTORY ============

const explainFactory = (snapshot) => {
  const facts = [
    fact("Contract", abbreviateAddress(snapshot.address), "read"),
    fact("Version", `v${snapshot.version}`, "read"),
    fact(
      "Splits deployed",
      String(snapshot.deployedSplitCount),
      "read"
    ),
    fact("Deployed at block", `#${snapshot.deploymentBlock}`, "event"),
  ];

  const evidence = [
    {
      label: "Factory contract on Sepolia",
      type: "ContractRead",
      blockNumber: snapshot.generatedAtBlock,
      transactionHash: null,
      etherscanUrl: addressUrl(snapshot.address),
    },
    ...snapshot.splits
      .filter((split) => split.creationTxHash)
      .map((split) => ({
        label: `${split.title} created by the factory`,
        type: "SplitCreated",
        blockNumber: split.createdAtBlock,
        transactionHash: split.creationTxHash,
        etherscanUrl: txUrl(split.creationTxHash),
      })),
  ];

  return answer({
    id: "explain-factory",
    title: "Explain the factory",
    summary:
      `SplitFactory v${snapshot.version} deploys and indexes EthSplit contracts. ` +
      `Anyone can call createSplit, which deploys a new split whose manager is the caller, ` +
      `and records it so the dashboard can discover it without an indexer. ` +
      `It currently tracks ${plural(snapshot.deployedSplitCount, "split")}.`,
    status: statusFor(snapshot, true),
    facts,
    evidence,
    generatedAtBlock: snapshot.generatedAtBlock,
    note: incompletenessNote(snapshot),
  });
};

// ============ 2. SUMMARIZE RECENT ACTIVITY ============

/** Flattens every split's evidence into one chronological stream. */
const activityStream = (snapshot) => {
  const entries = [];

  snapshot.splits.forEach((split) => {
    if (split.creationTxHash) {
      entries.push({
        blockNumber: split.createdAtBlock,
        label: `${split.title} deployed by the factory`,
        type: "SplitCreated",
        transactionHash: split.creationTxHash,
        etherscanUrl: txUrl(split.creationTxHash),
      });
    }

    split.rounds.forEach((round) => {
      round.evidence.forEach((item) => {
        entries.push({
          blockNumber: item.blockNumber,
          label: `${split.title}: ${item.label}`,
          type: item.type,
          transactionHash: item.transactionHash,
          etherscanUrl: item.etherscanUrl,
        });
      });
    });

    if (split.withdrawalCount > 0) {
      entries.push({
        blockNumber: null,
        label: `${split.title}: ${plural(
          split.withdrawalCount,
          "withdrawal"
        )} completed`,
        type: "Withdrawal",
        transactionHash: null,
        etherscanUrl: addressUrl(split.address),
        withdrawalSummary: true,
      });
    }
  });

  return entries
    .filter((entry) => entry.blockNumber !== null || entry.withdrawalSummary)
    .sort((a, b) => (a.blockNumber || 0) - (b.blockNumber || 0));
};

const summarizeRecentActivity = (snapshot) => {
  const stream = activityStream(snapshot);
  const withBlocks = stream.filter((entry) => entry.blockNumber !== null);

  if (stream.length === 0) {
    return answer({
      id: "recent-activity",
      title: "Summarize recent activity",
      summary:
        "No on-chain activity has been recorded for the demo splits in the queried block range.",
      status: "empty",
      generatedAtBlock: snapshot.generatedAtBlock,
      note: incompletenessNote(snapshot),
    });
  }

  const firstBlock = withBlocks.length ? withBlocks[0].blockNumber : null;
  const lastBlock = withBlocks.length
    ? withBlocks[withBlocks.length - 1].blockNumber
    : null;

  const totalJoins = snapshot.splits.reduce(
    (sum, split) =>
      sum + split.rounds.reduce((inner, round) => inner + round.joinCount, 0),
    0
  );
  const totalFundings = snapshot.splits.reduce(
    (sum, split) =>
      sum + split.rounds.filter((round) => round.fundedWei > 0n).length,
    0
  );
  const totalFinalizations = snapshot.splits.reduce(
    (sum, split) => sum + split.rounds.filter((round) => round.finalized).length,
    0
  );
  const totalWithdrawals = snapshot.splits.reduce(
    (sum, split) => sum + split.withdrawalCount,
    0
  );

  const facts = [
    fact("Splits created", String(snapshot.splits.length), "event"),
    fact("Participant joins", String(totalJoins), "event"),
    fact("Funding transactions", String(totalFundings), "event"),
    fact("Distributions finalized", String(totalFinalizations), "event"),
    fact("Withdrawals", String(totalWithdrawals), "event"),
  ];

  if (firstBlock !== null) {
    facts.push(
      fact("Activity block range", `#${firstBlock} – #${lastBlock}`, "event")
    );
  }

  return answer({
    id: "recent-activity",
    title: "Summarize recent activity",
    summary:
      `Across ${plural(snapshot.splits.length, "split")}, the factory recorded ` +
      `${plural(totalJoins, "participant join")}, ` +
      `${plural(totalFundings, "funding transaction")}, ` +
      `${plural(totalFinalizations, "finalized distribution")} and ` +
      `${plural(totalWithdrawals, "withdrawal")}` +
      (lastBlock !== null ? `, most recently at block #${lastBlock}.` : "."),
    status: statusFor(snapshot, true),
    facts,
    evidence: stream
      .filter((entry) => entry.transactionHash)
      .map((entry) => ({
        label: entry.label,
        type: entry.type,
        blockNumber: entry.blockNumber,
        transactionHash: entry.transactionHash,
        etherscanUrl: entry.etherscanUrl,
      })),
    generatedAtBlock: snapshot.generatedAtBlock,
    note: incompletenessNote(snapshot),
  });
};

// ============ 3. WHICH SPLITS ARE ACTIVE ============

/** One sentence describing a split's live lifecycle position. */
const describeLifecycle = (split) => {
  const finalizedRounds = split.rounds.filter((round) => round.finalized);

  if (finalizedRounds.length > 0) {
    const last = finalizedRounds[finalizedRounds.length - 1];
    const sentences = [
      `Round ${last.round} finalized with ${plural(
        last.finalizedParticipantCount,
        "participant"
      )}.`,
    ];

    sentences.push(
      split.outstandingClaimCount === 0
        ? "All claims have been withdrawn."
        : `${numberWord(split.outstandingClaimCount)} claim${
            split.outstandingClaimCount === 1 ? "" : "s"
          } remain outstanding.`
    );

    sentences.push(
      `Round ${split.currentRound} is open and currently has ${plural(
        split.currentParticipantCount,
        "joined participant"
      )}.`
    );

    return sentences.join(" ");
  }

  if (split.lifecycleState === LIFECYCLE.AWAITING_DISTRIBUTION) {
    return `Round ${split.currentRound} is open and funded with ${formatEthText(
      split.roundPoolWei
    )}. ${plural(
      split.currentParticipantCount,
      "participant"
    )} have joined. Awaiting finalization.`;
  }

  if (split.lifecycleState === LIFECYCLE.AWAITING_FUNDING) {
    return `Round ${split.currentRound} is open. ${plural(
      split.currentParticipantCount,
      "participant"
    )} have joined. Awaiting funding and distribution.`;
  }

  return `Round ${split.currentRound} is open. No participants have joined yet.`;
};

const whichSplitsAreActive = (snapshot) => {
  if (snapshot.splits.length === 0) {
    return answer({
      id: "active-splits",
      title: "Which splits are active?",
      summary: "The factory has not deployed any splits yet.",
      status: "empty",
      generatedAtBlock: snapshot.generatedAtBlock,
      note: incompletenessNote(snapshot),
    });
  }

  const awaitingFunding = snapshot.splits.filter(
    (split) => split.lifecycleState === LIFECYCLE.AWAITING_FUNDING
  ).length;
  const withClaims = snapshot.splits.filter(
    (split) => split.lifecycleState === LIFECYCLE.CLAIMS_OUTSTANDING
  ).length;

  const facts = snapshot.splits.map((split) =>
    fact(split.title, describeLifecycle(split), "derived")
  );

  const parts = [];
  if (awaitingFunding > 0) {
    parts.push(`${plural(awaitingFunding, "split")} awaiting funding`);
  }
  if (withClaims > 0) {
    parts.push(`${plural(withClaims, "split")} with claims outstanding`);
  }

  return answer({
    id: "active-splits",
    title: "Which splits are active?",
    summary:
      `All ${plural(snapshot.splits.length, "split")} are live on Sepolia` +
      (parts.length ? `: ${parts.join(", ")}.` : "."),
    status: statusFor(snapshot, true),
    facts,
    evidence: snapshot.splits.map((split) => ({
      label: `${split.title} contract state`,
      type: "ContractRead",
      blockNumber: snapshot.generatedAtBlock,
      transactionHash: null,
      etherscanUrl: addressUrl(split.address),
    })),
    generatedAtBlock: snapshot.generatedAtBlock,
    note: incompletenessNote(snapshot),
  });
};

// ============ 4. WHAT ETH IS CURRENTLY HELD ============

const ethCurrentlyHeld = (snapshot) => {
  const totalWei = snapshot.splits.reduce(
    (sum, split) => sum + split.balanceWei,
    0n
  );
  const claimableWei = snapshot.splits.reduce(
    (sum, split) => sum + split.totalClaimableWei,
    0n
  );
  const unallocatedWei = snapshot.splits.reduce(
    (sum, split) => sum + split.roundPoolWei,
    0n
  );

  const facts = [
    fact(
      "Total held across split contracts",
      formatEthText(totalWei),
      "read"
    ),
    fact(
      "Allocated to participants, not yet withdrawn",
      formatEthText(claimableWei),
      "read"
    ),
    fact(
      "Unallocated in open round pools",
      formatEthText(unallocatedWei),
      "read"
    ),
  ];

  snapshot.splits
    .filter((split) => split.balanceWei > 0n)
    .forEach((split) =>
      facts.push(fact(split.title, formatEthText(split.balanceWei), "read"))
    );

  // Dust is explained rather than inflated: an equal split that does not divide
  // evenly leaves a remainder in the pool for the next round.
  const dustSplits = snapshot.splits.filter(
    (split) => split.roundPoolWei > 0n && split.roundPoolWei < 1000n
  );

  const dustNote = dustSplits.length
    ? `${dustSplits
        .map((split) => `${split.title} holds ${split.roundPoolWei} wei`)
        .join("; ")} of division remainder — an equal split of a round that does ` +
      "not divide evenly leaves this behind for the next round. It is not a " +
      "meaningful balance."
    : null;

  return answer({
    id: "eth-held",
    title: "What ETH is currently held?",
    summary:
      `${formatEthText(totalWei)} is currently held across the split contracts. ` +
      `Of that, ${formatEthText(
        claimableWei
      )} is allocated to participants and awaiting withdrawal` +
      (unallocatedWei > 0n
        ? `, and ${formatEthText(unallocatedWei)} sits unallocated in open round pools.`
        : "."),
    status: statusFor(snapshot, snapshot.splits.length > 0),
    facts,
    evidence: snapshot.splits.map((split) => ({
      label: `${split.title} balance read`,
      type: "ContractRead",
      blockNumber: snapshot.generatedAtBlock,
      transactionHash: null,
      etherscanUrl: addressUrl(split.address),
    })),
    generatedAtBlock: snapshot.generatedAtBlock,
    note: [incompletenessNote(snapshot), dustNote].filter(Boolean).join(" ") || null,
  });
};

// ============ 5. EXPLAIN ONE SPLIT ============

const explainSplit = (snapshot, splitAddress, questionId) => {
  const split = snapshot.splits.find(
    (candidate) =>
      candidate.address.toLowerCase() === String(splitAddress).toLowerCase()
  );

  if (!split) {
    return answer({
      id: questionId,
      title: "Explain this split",
      summary: "That split is not present on the active demo factory.",
      status: "empty",
      generatedAtBlock: snapshot.generatedAtBlock,
    });
  }

  const facts = [];
  const evidence = [];

  facts.push(fact("Contract", abbreviateAddress(split.address), "read"));
  facts.push(fact("Version", `v${split.version}`, "read"));

  if (split.creationTxHash) {
    facts.push(fact("Created at block", `#${split.createdAtBlock}`, "event"));
    evidence.push({
      label: `${split.title} deployed by the factory`,
      type: "SplitCreated",
      blockNumber: split.createdAtBlock,
      transactionHash: split.creationTxHash,
      etherscanUrl: txUrl(split.creationTxHash),
    });
  }

  // Walk every reconstructed round in order.
  split.rounds.forEach((round) => {
    if (round.joinCount > 0) {
      facts.push(
        fact(
          `Round ${round.round} participants`,
          `${plural(round.joinCount, "participant")} joined`,
          "event"
        )
      );
    }

    if (round.fundedWei > 0n) {
      facts.push(
        fact(
          `Round ${round.round} funding`,
          `Pool funded with ${formatEthText(round.fundedWei)}`,
          "event"
        )
      );
    }

    if (round.finalized) {
      facts.push(
        fact(
          `Round ${round.round} distribution`,
          `Finalized equally: ${formatEthText(
            round.amountPerParticipantWei
          )} to each of ${plural(round.finalizedParticipantCount, "participant")}`,
          "event"
        )
      );

      if (round.remainderWei > 0n) {
        facts.push(
          fact(
            `Round ${round.round} remainder`,
            `${round.remainderWei} wei of division dust carried to the next round`,
            "event"
          )
        );
      }
    }

    round.evidence.forEach((item) => evidence.push(item));
  });

  if (split.withdrawalCount > 0) {
    facts.push(
      fact(
        "Withdrawals",
        `${plural(split.withdrawalCount, "withdrawal")} completed, totalling ${formatEthText(
          split.withdrawnTotalWei
        )}`,
        "event"
      )
    );
  }

  facts.push(
    fact(
      "Outstanding claims",
      split.outstandingClaimCount === 0
        ? "None — every allocation has been withdrawn"
        : `${numberWord(split.outstandingClaimCount)} claim${
            split.outstandingClaimCount === 1 ? "" : "s"
          } remain outstanding, totalling ${formatEthText(split.totalClaimableWei)}`,
      "derived"
    )
  );

  facts.push(
    fact(
      "Current round",
      `Round ${split.currentRound} is open with ${plural(
        split.currentParticipantCount,
        "joined participant"
      )}`,
      "read"
    )
  );

  facts.push(fact("Contract balance", formatEthText(split.balanceWei), "read"));

  evidence.push({
    label: `${split.title} current state read at block ${snapshot.generatedAtBlock}`,
    type: "ContractRead",
    blockNumber: snapshot.generatedAtBlock,
    transactionHash: null,
    etherscanUrl: addressUrl(split.address),
  });

  return answer({
    id: questionId,
    title: `Explain ${split.title}`,
    summary: describeLifecycle(split),
    status: statusFor(snapshot, true),
    facts,
    evidence,
    generatedAtBlock: snapshot.generatedAtBlock,
    note: incompletenessNote(snapshot),
  });
};

// ============ DISPATCH ============

/**
 * Runs the deterministic rule for one guided question.
 *
 * @param {string} questionId
 * @param {import("./model").FactorySnapshot} snapshot
 * @param {Object} [options]
 * @param {string} [options.splitAddress] Required for split-specific questions.
 * @returns {IntelligenceAnswer}
 */
const analyze = (questionId, snapshot, options = {}) => {
  switch (questionId) {
    case "explain-factory":
      return explainFactory(snapshot);
    case "recent-activity":
      return summarizeRecentActivity(snapshot);
    case "active-splits":
      return whichSplitsAreActive(snapshot);
    case "eth-held":
      return ethCurrentlyHeld(snapshot);
    default:
      if (options.splitAddress) {
        return explainSplit(snapshot, options.splitAddress, questionId);
      }

      return answer({
        id: questionId,
        title: "Unknown question",
        summary: "No deterministic rule is defined for that question.",
        status: "empty",
        generatedAtBlock: snapshot.generatedAtBlock,
      });
  }
};

module.exports = {
  analyze,
  explainFactory,
  summarizeRecentActivity,
  whichSplitsAreActive,
  ethCurrentlyHeld,
  explainSplit,
  describeLifecycle,
};
