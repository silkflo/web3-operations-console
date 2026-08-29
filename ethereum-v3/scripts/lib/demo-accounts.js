// ethereum-v3/scripts/lib/demo-accounts.js
//
// Controlled Sepolia demo participant wallets.
//
// EthSplit.join() is msg.sender-based and the manager is barred from joining,
// so a demo participant must be able to sign its own transaction. These wallets
// are derived deterministically from DEMO_MNEMONIC, which lives only in the
// gitignored .env. Deriving rather than storing addresses means the same pool
// comes back on every run, which is what makes the seed script idempotent and
// the manifest reproducible.
//
// SECURITY:
//   - Testnet only. This mnemonic must never hold mainnet value.
//   - Only the derived public ADDRESSES are ever written to the manifest,
//     logged, or committed. The phrase and the private keys are never printed.

const { ethers } = require("ethers");

/** Standard Ethereum derivation path. */
const DERIVATION_PATH = "m/44'/60'/0'/0";

/**
 * Size of the shared wallet pool.
 *
 * Scenarios reuse the pool rather than each taking a fresh set, so the pool only
 * needs to be as large as the largest scenario. Fewer wallets means fewer
 * gas-float transfers and less test ETH stranded in throwaway accounts.
 */
const DEMO_ACCOUNT_COUNT = 4;

/**
 * Derives the demo participant pool.
 *
 * @param {string} mnemonic BIP-39 phrase from DEMO_MNEMONIC.
 * @param {number} count How many wallets to derive.
 * @returns {ethers.HDNodeWallet[]} Wallets, index 0..count-1.
 */
const deriveDemoAccounts = (mnemonic, count = DEMO_ACCOUNT_COUNT) => {
  if (!mnemonic || typeof mnemonic !== "string" || mnemonic.trim() === "") {
    throw new Error(
      "DEMO_MNEMONIC is not set. Add it to ethereum-v3/.env — see .env.example."
    );
  }

  if (!ethers.Mnemonic.isValidMnemonic(mnemonic.trim())) {
    throw new Error("DEMO_MNEMONIC is not a valid BIP-39 mnemonic phrase.");
  }

  const root = ethers.HDNodeWallet.fromPhrase(
    mnemonic.trim(),
    undefined,
    DERIVATION_PATH
  );

  const accounts = [];

  for (let index = 0; index < count; index += 1) {
    accounts.push(root.deriveChild(index));
  }

  return accounts;
};

/** Picks the participants for one scenario from the shared pool. */
const participantsForScenario = (pool, participantCount) => {
  if (participantCount > pool.length) {
    throw new Error(
      `Scenario needs ${participantCount} participants but the demo pool only has ${pool.length}.`
    );
  }

  return pool.slice(0, participantCount);
};

module.exports = {
  DERIVATION_PATH,
  DEMO_ACCOUNT_COUNT,
  deriveDemoAccounts,
  participantsForScenario,
};
