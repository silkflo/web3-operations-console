// ethereum-v3/scripts/lib/scenarios.js
//
// Single source of truth for the portfolio demo scenarios.
//
// Consumed by scripts/seed-demo.js and by test/demo/*.test.js, so the seeded
// environment and the tests can never drift apart.
//
// SCOPE — full lifecycle (see DEMO_FUNDING_PLAN.md):
// Every scenario is created and has REAL participants join from controlled
// wallets. Exactly one scenario is additionally funded, finalized and partially
// withdrawn, so the dashboard shows three genuinely different contract states.
//
// ALLOCATION MODEL:
// EthSplit V3 distributes a round strictly equally
// (`amountPerParticipant = roundPool / participantCount`). The contract has no
// per-participant weights. Every `allocation` block below therefore describes
// an EQUAL split. Do not add weighted percentages unless the contract itself
// gains weighted distribution.

const SCENARIOS = [
  {
    key: "creator-revenue-share",
    title: "Creator Revenue Share",
    description:
      "A creator collaboration: three contributors on a joint video series split sponsorship revenue equally. Funded, finalized, and one contributor has withdrawn their share.",
    participantCount: 3,
    // The one scenario taken through the full lifecycle.
    fundingEth: "0.001",
    finalize: true,
    withdrawParticipants: 1,
  },
  {
    key: "product-team-bonus",
    title: "Product Team Bonus",
    description:
      "A software delivery scenario: a four-person team has joined to share a milestone bonus, awaiting the manager funding the round.",
    participantCount: 4,
    fundingEth: null,
    finalize: false,
    withdrawParticipants: 0,
  },
  {
    key: "project-partner-settlement",
    title: "Project Partner Settlement",
    description:
      "A client/partner settlement: three partners have joined to settle a completed engagement, awaiting funding.",
    participantCount: 3,
    fundingEth: null,
    finalize: false,
    withdrawParticipants: 0,
  },
];

/** Equal-split share for a participant count, as a display string. */
const equalSharePercent = (participantCount) =>
  `${(100 / participantCount).toFixed(2)}%`;

/** Builds the manifest `allocation` block for a scenario. */
const buildAllocation = (scenario) => ({
  model: "equal",
  participantCount: scenario.participantCount,
  perParticipantShare: equalSharePercent(scenario.participantCount),
  note: "EthSplit V3 divides each funded round equally among the participants of that round. The contract has no weighted or percentage allocation.",
});

module.exports = {
  SCENARIOS,
  equalSharePercent,
  buildAllocation,
};
