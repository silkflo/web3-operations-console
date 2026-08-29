// ethereum-v3/scripts/estimate-demo.js
//
// Prices the ENTIRE demo-lite workflow — factory deployment plus one
// createSplit per scenario — without broadcasting anything to Sepolia.
//
// How the numbers are produced:
//   - GAS is measured exactly, by actually running the workflow on the
//     in-process Hardhat EVM. Gas used is deterministic for the same bytecode
//     and EVM version, so a local measurement is the real Sepolia gas. This
//     also captures the fresh-factory cost correctly: the first createSplit
//     writes a zero storage slot and is more expensive than later ones, which
//     estimating against the already-populated old factory would understate.
//   - PRICE and BALANCE come from live Sepolia over a read-only JSON-RPC call.
//
// Runs on the hardhat network on purpose. Nothing is signed against Sepolia.
//
// Usage:
//   npm run estimate:demo

const { ethers } = require("hardhat");
const { JsonRpcProvider, Wallet } = require("ethers");

const { SCENARIOS } = require("./lib/scenarios");
const {
  BUDGET_ETH,
  assertWithinBudget,
  pricePlan,
  printPlan,
} = require("./lib/budget");

const SEPOLIA_CHAIN_ID = 11155111;

/** Reads live fee data and the deployer balance from Sepolia, read-only. */
const readSepoliaState = async () => {
  const rpcUrl = process.env.SEPOLIA_RPC_URL;

  if (!rpcUrl) {
    throw new Error("SEPOLIA_RPC_URL is not set; cannot price the plan.");
  }

  const provider = new JsonRpcProvider(rpcUrl, {
    chainId: SEPOLIA_CHAIN_ID,
    name: "sepolia",
  });

  const chain = await provider.getNetwork();

  if (Number(chain.chainId) !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `SEPOLIA_RPC_URL points at chainId ${chain.chainId}, not Sepolia (${SEPOLIA_CHAIN_ID}).`
    );
  }

  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not set; cannot read the balance.");
  }

  // Address only — the key is never used to sign anything in this script.
  const deployerAddress = new Wallet(process.env.DEPLOYER_PRIVATE_KEY).address;

  const [feeData, balance, blockNumber] = await Promise.all([
    provider.getFeeData(),
    provider.getBalance(deployerAddress),
    provider.getBlockNumber(),
  ]);

  const feePerGas = feeData.maxFeePerGas || feeData.gasPrice;

  if (!feePerGas) {
    throw new Error("Sepolia RPC returned no gas price data.");
  }

  return { deployerAddress, balance, feePerGas, feeData, blockNumber };
};

/** Measures exact gas for the whole workflow on the local EVM. */
const measureGas = async () => {
  const SplitFactory = await ethers.getContractFactory("SplitFactory");

  const factory = await SplitFactory.deploy();
  await factory.waitForDeployment();

  const deployReceipt = await factory.deploymentTransaction().wait();

  const items = [
    { label: "SplitFactory deployment", gas: deployReceipt.gasUsed },
  ];

  for (const scenario of SCENARIOS) {
    const tx = await factory.createSplit(scenario.title);
    const receipt = await tx.wait();

    items.push({
      label: `createSplit "${scenario.title}"`,
      gas: receipt.gasUsed,
    });
  }

  return items;
};

async function main() {
  console.log("==========================================");
  console.log("Demo-lite cost estimate — NOTHING BROADCAST");
  console.log("==========================================");

  const sepolia = await readSepoliaState();

  console.log("Sepolia block:  ", sepolia.blockNumber);
  console.log("Deployer:       ", sepolia.deployerAddress);
  console.log("Balance:        ", ethers.formatEther(sepolia.balance), "ETH");
  console.log(
    "Base fee:       ",
    sepolia.feeData.gasPrice
      ? `${ethers.formatUnits(sepolia.feeData.gasPrice, "gwei")} gwei`
      : "n/a"
  );
  console.log(
    "Max fee ceiling:",
    `${ethers.formatUnits(sepolia.feePerGas, "gwei")} gwei`
  );
  console.log("Scenarios:      ", SCENARIOS.length, "(no funding, no joins)");
  console.log("Transactions:   ", SCENARIOS.length + 1);

  const items = await measureGas();
  const plan = pricePlan(items, sepolia.feePerGas);

  printPlan(plan, sepolia.feePerGas, sepolia.balance);

  const withinBudget = assertWithinBudget(
    plan,
    sepolia.balance,
    SCENARIOS.length
  );

  if (!withinBudget) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `Within the ${BUDGET_ETH} ETH hard budget.`
  );
  console.log("To proceed:  npm run deploy:demo:sepolia");
  console.log("==========================================");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
