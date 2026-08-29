// ethereum-v3/scripts/lib/budget.js
//
// Worst-case cost estimation and the hard spend gate for the demo-lite
// deployment.
//
// Every planned transaction is estimated before anything is broadcast, priced
// at the configured max fee ceiling (not the current base fee), and compared
// against BUDGET_ETH. If the worst case exceeds the budget, the caller aborts.

const { ethers } = require("hardhat");

/**
 * Hard ceiling for a single deploy/seed/lifecycle run, in ETH.
 *
 * Raised from 0.010 to 0.020 to authorise the full lifecycle deployment
 * described in DEMO_FUNDING_PLAN.md (factory + 3 splits + 10 participant joins
 * + one funded/finalized round + one withdrawal), which the demo-lite ceiling
 * was never meant to cover. This is a deliberate, reviewed change.
 *
 * MIN_REMAINING_ETH is intentionally NOT raised with it: the reserve floor is
 * what stops a run draining the wallet, and it stays at 0.010.
 */
const BUDGET_ETH = "0.020";

/**
 * Minimum test ETH that must REMAIN in the deployer wallet after every planned
 * transaction has been paid for at the worst-case fee.
 *
 * Separate from BUDGET_ETH on purpose: the budget caps what a run may spend,
 * this floor guarantees the wallet is not drained to the point where a follow-up
 * run, a retry, or a later milestone becomes impossible without a faucet trip.
 * A plan must satisfy BOTH.
 */
const MIN_REMAINING_ETH = "0.010";

const BUDGET_WEI = ethers.parseEther(BUDGET_ETH);
const MIN_REMAINING_WEI = ethers.parseEther(MIN_REMAINING_ETH);

/**
 * The fee per gas used for worst-case pricing.
 *
 * maxFeePerGas is the ceiling a transaction can actually pay under EIP-1559, so
 * it is the honest number for a worst case. Falls back to gasPrice on a chain
 * that does not report one.
 */
const worstCaseFeePerGas = async () => {
  const fee = await ethers.provider.getFeeData();
  const perGas = fee.maxFeePerGas || fee.gasPrice;

  if (!perGas) {
    throw new Error("RPC returned no gas price data; cannot price the budget.");
  }

  return perGas;
};

/**
 * Prices a list of planned transactions.
 *
 * @param {{label: string, gas: bigint}[]} items
 * @param {bigint} feePerGas
 */
const pricePlan = (items, feePerGas) => {
  const rows = items.map((item) => ({
    label: item.label,
    gas: item.gas,
    costWei: item.gas * feePerGas,
  }));

  const totalGas = rows.reduce((sum, row) => sum + row.gas, 0n);
  const totalWei = rows.reduce((sum, row) => sum + row.costWei, 0n);

  return { rows, totalGas, totalWei };
};

/** Renders the transaction-by-transaction cost table. */
const printPlan = ({ rows, totalGas, totalWei }, feePerGas, balanceWei) => {
  const gwei = ethers.formatUnits(feePerGas, "gwei");

  console.log("");
  console.log("Worst-case cost plan (priced at maxFeePerGas)");
  console.log(`Fee ceiling: ${gwei} gwei`);
  console.log(
    "----------------------------------------------------------------------------------"
  );
  console.log(
    "  " +
      "Transaction".padEnd(42) +
      "Gas".padStart(12) +
      "Cost (ETH)".padStart(24)
  );
  console.log(
    "----------------------------------------------------------------------------------"
  );

  rows.forEach((row) => {
    console.log(
      "  " +
        row.label.padEnd(42) +
        row.gas.toString().padStart(12) +
        ethers.formatEther(row.costWei).padStart(24)
    );
  });

  console.log(
    "----------------------------------------------------------------------------------"
  );
  console.log(
    "  " +
      "TOTAL".padEnd(42) +
      totalGas.toString().padStart(12) +
      ethers.formatEther(totalWei).padStart(24)
  );
  console.log(
    "----------------------------------------------------------------------------------"
  );
  const remaining = balanceWei - totalWei;

  console.log("  Hard budget (max spend):   ", BUDGET_ETH, "ETH");
  console.log("  Required balance remaining:", MIN_REMAINING_ETH, "ETH");
  console.log("  Deployer balance:          ", ethers.formatEther(balanceWei), "ETH");
  console.log("  Balance after:             ", ethers.formatEther(remaining), "ETH");
  console.log(
    "  Budget headroom:           ",
    ethers.formatEther(BUDGET_WEI - totalWei),
    "ETH"
  );
  console.log(
    "  Reserve headroom:          ",
    ethers.formatEther(remaining - MIN_REMAINING_WEI),
    "ETH"
  );
  console.log("");
  console.log(
    "  Gate: a deployment is only permitted when the worst-case total stays"
  );
  console.log(
    `        under ${BUDGET_ETH} ETH AND leaves at least ${MIN_REMAINING_ETH} ETH in the wallet.`
  );
  console.log("");
};

/**
 * Aborts unless the plan fits both the hard budget and the deployer balance.
 * Reports the cheapest alternatives when it does not.
 */
const assertWithinBudget = ({ totalWei }, balanceWei, scenarioCount) => {
  const problems = [];

  if (totalWei > BUDGET_WEI) {
    problems.push(
      `worst-case cost ${ethers.formatEther(totalWei)} ETH exceeds the hard budget of ${BUDGET_ETH} ETH`
    );
  }

  if (totalWei > balanceWei) {
    problems.push(
      `worst-case cost ${ethers.formatEther(totalWei)} ETH exceeds the deployer balance of ${ethers.formatEther(balanceWei)} ETH`
    );
  }

  const remaining = balanceWei - totalWei;

  if (remaining < MIN_REMAINING_WEI) {
    problems.push(
      `worst-case run would leave ${ethers.formatEther(remaining)} ETH in the wallet, ` +
        `below the required ${MIN_REMAINING_ETH} ETH reserve ` +
        `(short by ${ethers.formatEther(MIN_REMAINING_WEI - remaining)} ETH)`
    );
  }

  if (problems.length === 0) {
    return true;
  }

  console.error("");
  console.error("ABORTED — nothing was broadcast.");
  problems.forEach((problem) => console.error("  - " + problem));
  console.error("");
  console.error("Cheapest alternatives, in order:");
  console.error(
    "  1. Wait for lower gas. This plan is priced at the maxFeePerGas ceiling;"
  );
  console.error(
    "     Sepolia base fee is frequently half of it. Re-run the estimate later."
  );
  console.error(
    `  2. Seed fewer scenarios. Each createSplit is roughly ${Math.round(
      100 / (scenarioCount + 1)
    )}% of this plan;`
  );
  console.error(
    "     edit scripts/lib/scenarios.js and re-run the estimate."
  );
  console.error(
    "  3. Deploy the factory only, and seed later in a separate run. The seed"
  );
  console.error(
    "     script is idempotent, so splitting the work across runs is safe."
  );
  console.error(
    "  4. Keep using the existing factory 0xe8c19124799bd4C2114966689F606a254D683D5d"
  );
  console.error(
    "     and accept the two old fixtures. Zero cost, but not a clean environment."
  );
  console.error(
    "  5. Top up the deployer with Sepolia test ETH from a faucet."
  );
  console.error("");

  return false;
};

module.exports = {
  BUDGET_ETH,
  BUDGET_WEI,
  MIN_REMAINING_ETH,
  MIN_REMAINING_WEI,
  worstCaseFeePerGas,
  pricePlan,
  printPlan,
  assertWithinBudget,
};
