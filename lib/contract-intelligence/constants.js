// lib/contract-intelligence/constants.js
//
// Shared constants for the Contract Intelligence pipeline. Kept separate so the
// pure model/analysis modules can be required by the CommonJS test suite without
// pulling in the frontend config module (which is ESM and imports JSON).

const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

/** How long a normalized snapshot stays fresh before a rebuild is needed. */
const SNAPSHOT_TTL_MS = 60000;

/** Guided question ids. There is no free-text entry point by design. */
const QUESTIONS = [
  {
    id: "explain-factory",
    label: "Explain the factory",
    hint: "What it does, version, and how many splits it has deployed",
  },
  {
    id: "recent-activity",
    label: "Summarize recent activity",
    hint: "Chronological on-chain events across the demo splits",
  },
  {
    id: "active-splits",
    label: "Which splits are active?",
    hint: "Lifecycle state of each split, with evidence",
  },
  {
    id: "eth-held",
    label: "What ETH is currently held?",
    hint: "Live balances summed across the split contracts",
  },
  {
    id: "explain-creator-revenue-share",
    label: "Explain Creator Revenue Share",
    hint: "Full lifecycle of the funded and finalized split",
    splitKey: "creator-revenue-share",
  },
];

module.exports = { SEPOLIA_EXPLORER, SNAPSHOT_TTL_MS, QUESTIONS };
