// ethereum-v3/scripts/estimate-lifecycle.js
//
// Prices the FULL demo lifecycle described in DEMO_FUNDING_PLAN.md — the
// version worth deploying, with real participants, a funded round, a
// finalization and a withdrawal.
//
// This is an estimator only. It never broadcasts, and the lifecycle seed script
// it prices does not exist yet; see DEMO_FUNDING_PLAN.md.
//
// Gas is measured exactly by running the whole lifecycle on the in-process
// Hardhat EVM. Price and balance come from live Sepolia over read-only calls.
//
// Usage:
//   npm run estimate:lifecycle

const { ethers } = require("hardhat");
const { JsonRpcProvider, Wallet } = require("ethers");

const { SCENARIOS } = require("./lib/scenarios");
const {
  BUDGET_ETH,
  MIN_REMAINING_ETH,
  MIN_REMAINING_WEI,
  pricePlan,
} = require("./lib/budget");

const SEPOLIA_CHAIN_ID = 11155111;

/** Test ETH funded into the one funded scenario. Deliberately tiny. */
const FUNDING_ETH = "0.001";

/**
 * Head-room multiplier applied to each demo wallet's own measured gas when
 * sizing its float. The float must cover that wallet's joins and any
 * withdrawal; anything left over is stranded, so it is sized per wallet rather
 * than as one flat figure.
 */
const FLOAT_HEADROOM_MULTIPLIER = 150n; // 1.50x
const FLOAT_HEADROOM_DIVISOR = 100n;

/** Safety buffer over the priced worst case, for gas drift mid-run. */
const SAFETY_BUFFER_MULTIPLIER = 130n; // 1.30x
const SAFETY_BUFFER_DIVISOR = 100n;

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
      `SEPOLIA_RPC_URL points at chainId ${chain.chainId}, not Sepolia.`
    );
  }

  const deployerAddress = new Wallet(process.env.DEPLOYER_PRIVATE_KEY).address;

  const [feeData, balance, blockNumber] = await Promise.all([
    provider.getFeeData(),
    provider.getBalance(deployerAddress),
    provider.getBlockNumber(),
  ]);

  return {
    deployerAddress,
    balance,
    feePerGas: feeData.maxFeePerGas || feeData.gasPrice,
    feeData,
    blockNumber,
  };
};

/**
 * Runs the complete lifecycle locally and records gas for every transaction.
 *
 * Mirrors DEMO_FUNDING_PLAN.md exactly: factory, three splits, real joins for
 * every scenario, one funded + finalized split, one withdrawal.
 */
const measureLifecycle = async () => {
  const signers = await ethers.getSigners();
  const manager = signers[0];

  // Distinct controlled wallets, reused across scenarios. The pool only needs
  // to be as large as the biggest scenario.
  const poolSize = Math.max(...SCENARIOS.map((s) => s.participantCount));
  const pool = signers.slice(1, 1 + poolSize);

  const items = [];

  const SplitFactory = await ethers.getContractFactory("SplitFactory");
  const factory = await SplitFactory.deploy();
  await factory.waitForDeployment();

  items.push({
    label: "SplitFactory deployment",
    gas: (await factory.deploymentTransaction().wait()).gasUsed,
    payer: "deployer",
    wallet: null,
  });

  // One gas-float transfer per controlled wallet, so each can sign its own join.
  const floatTransfer = await manager.sendTransaction({
    to: pool[0].address,
    value: ethers.parseEther("0.0001"),
  });
  const floatGas = (await floatTransfer.wait()).gasUsed;

  for (let i = 0; i < poolSize; i += 1) {
    items.push({
      label: `gas float -> demo wallet ${i + 1}`,
      gas: floatGas,
      payer: "deployer",
      wallet: null,
    });
  }

  const splits = [];

  for (const scenario of SCENARIOS) {
    const receipt = await (await factory.createSplit(scenario.title)).wait();

    items.push({
      label: `createSplit "${scenario.title}"`,
      gas: receipt.gasUsed,
      payer: "deployer",
      wallet: null,
    });

    const created = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "SplitCreated");

    const split = await ethers.getContractAt(
      "EthSplit",
      created.args.splitAddress
    );

    splits.push({ scenario, split });

    for (let i = 0; i < scenario.participantCount; i += 1) {
      const joinReceipt = await (await split.connect(pool[i]).join()).wait();

      items.push({
        label: `join #${i + 1} — ${scenario.title}`,
        gas: joinReceipt.gasUsed,
        payer: "participant",
        wallet: i,
      });
    }
  }

  // Exactly one scenario gets funded, finalized and partially withdrawn.
  const funded = splits[0];

  const fundReceipt = await (
    await funded.split.fund({ value: ethers.parseEther(FUNDING_ETH) })
  ).wait();
  items.push({
    label: `fund ${FUNDING_ETH} ETH — ${funded.scenario.title}`,
    gas: fundReceipt.gasUsed,
    payer: "deployer",
    wallet: null,
  });

  const finalizeReceipt = await (
    await funded.split.finalizeDistribution()
  ).wait();
  items.push({
    label: `finalizeDistribution — ${funded.scenario.title}`,
    gas: finalizeReceipt.gasUsed,
    payer: "deployer",
    wallet: null,
  });

  const withdrawReceipt = await (
    await funded.split.connect(pool[0]).withdraw()
  ).wait();
  items.push({
    label: `withdraw (1 participant) — ${funded.scenario.title}`,
    gas: withdrawReceipt.gasUsed,
    payer: "participant",
    wallet: 0,
  });

  return { items, poolSize };
};

async function main() {
  console.log("==================================================");
  console.log("FULL LIFECYCLE cost estimate — NOTHING BROADCAST");
  console.log("==================================================");

  const sepolia = await readSepoliaState();
  const { items, poolSize } = await measureLifecycle();

  const plan = pricePlan(items, sepolia.feePerGas);
  const gwei = ethers.formatUnits(sepolia.feePerGas, "gwei");

  console.log("Sepolia block:  ", sepolia.blockNumber);
  console.log("Deployer:       ", sepolia.deployerAddress);
  console.log("Balance:        ", ethers.formatEther(sepolia.balance), "ETH");
  console.log("Max fee ceiling:", gwei, "gwei");
  console.log("Scenarios:      ", SCENARIOS.length);
  console.log("Demo wallets:   ", poolSize, "(controlled, reused across scenarios)");
  console.log("Transactions:   ", items.length);
  console.log("");

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

  plan.rows.forEach((row) => {
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

  // Accounting note: participant gas is NOT an extra charge on the deployer.
  // Those transactions are paid out of the floats the deployer already sent, so
  // adding both would double-count. Deployer-paid gas and the ETH actually
  // leaving the deployer wallet are what determine the required balance.
  const deployerGasWei = plan.rows
    .filter((row, index) => items[index].payer === "deployer")
    .reduce((sum, row) => sum + row.costWei, 0n);

  // Size each wallet's float from its own measured gas, not a flat guess: the
  // wallet that joins every scenario needs materially more than the others, and
  // anything over-sent is stranded in a throwaway wallet.
  const perWalletGas = new Array(poolSize).fill(0n);

  plan.rows.forEach((row, index) => {
    const item = items[index];
    if (item.payer === "participant") {
      perWalletGas[item.wallet] += row.costWei;
    }
  });

  const perWalletFloat = perWalletGas.map(
    (cost) => (cost * FLOAT_HEADROOM_MULTIPLIER) / FLOAT_HEADROOM_DIVISOR
  );

  const floatTotal = perWalletFloat.reduce((sum, value) => sum + value, 0n);
  const participantGasWei = perWalletGas.reduce((sum, value) => sum + value, 0n);
  const fundingTotal = ethers.parseEther(FUNDING_ETH);

  console.log(
    "  " +
      "Deployer-paid gas".padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(deployerGasWei).padStart(24)
  );
  console.log(
    "  " +
      "Participant-paid gas (from floats)".padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(participantGasWei).padStart(24)
  );
  console.log("");
  console.log("  Per-wallet float sizing (measured gas x1.5):");

  perWalletFloat.forEach((value, index) => {
    console.log(
      "    demo wallet " +
        (index + 1) +
        ": gas " +
        ethers.formatEther(perWalletGas[index]).padEnd(24) +
        " float " +
        ethers.formatEther(value)
    );
  });

  console.log("");
  console.log("  ETH LEAVING THE DEPLOYER WALLET");
  console.log(
    "  " +
      "  deployer gas".padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(deployerGasWei).padStart(24)
  );
  console.log(
    "  " +
      `  gas floats to ${poolSize} demo wallets`.padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(floatTotal).padStart(24)
  );
  console.log(
    "  " +
      "  ETH funded into the demo round".padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(fundingTotal).padStart(24)
  );

  const subtotal = deployerGasWei + floatTotal + fundingTotal;
  const withBuffer =
    (subtotal * SAFETY_BUFFER_MULTIPLIER) / SAFETY_BUFFER_DIVISOR;
  const buffer = withBuffer - subtotal;

  console.log(
    "----------------------------------------------------------------------------------"
  );
  console.log(
    "  " +
      "SUBTOTAL".padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(subtotal).padStart(24)
  );
  console.log(
    "  " +
      "safety buffer (30%, gas drift)".padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(buffer).padStart(24)
  );
  console.log(
    "----------------------------------------------------------------------------------"
  );
  console.log(
    "  " +
      "TOTAL SPEND REQUIRED".padEnd(42) +
      "".padStart(12) +
      ethers.formatEther(withBuffer).padStart(24)
  );
  console.log(
    "----------------------------------------------------------------------------------"
  );

  const requiredBalance = withBuffer + MIN_REMAINING_WEI;
  const shortfall = requiredBalance - sepolia.balance;

  console.log("");
  console.log("  Required reserve after the run:", MIN_REMAINING_ETH, "ETH");
  console.log(
    "  Wallet balance needed:         ",
    ethers.formatEther(requiredBalance),
    "ETH"
  );
  console.log(
    "  Current balance:               ",
    ethers.formatEther(sepolia.balance),
    "ETH"
  );

  if (shortfall > 0n) {
    console.log(
      "  TOP-UP NEEDED:                 ",
      ethers.formatEther(shortfall),
      "ETH"
    );
  } else {
    console.log(
      "  Surplus:                       ",
      ethers.formatEther(-shortfall),
      "ETH"
    );
  }

  console.log("");
  console.log(
    `  Per-run budget ceiling: ${BUDGET_ETH} ETH. The lifecycle is executed in`
  );
  console.log(
    "  three separately gated phases (deploy, seed, lifecycle), each of which"
  );
  console.log(
    "  must independently satisfy the ceiling and the reserve floor."
  );
  console.log("  Nothing was broadcast.");
  console.log("==================================================");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
