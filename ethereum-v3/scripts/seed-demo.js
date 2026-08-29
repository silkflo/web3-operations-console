// ethereum-v3/scripts/seed-demo.js
//
// Seeds the clean demo factory with the portfolio scenarios: creates each split
// and has REAL participants join from controlled demo wallets.
//
// Funding, finalization and withdrawal are a separate step — see
// scripts/lifecycle-demo.js — so each phase can be priced, gated and resumed
// independently.
//
// Participants: EthSplit.join() is msg.sender-based and the manager is barred
// from joining, so each demo wallet signs its own join. The deployer tops each
// wallet up with a gas float first, sized from measured gas.
//
// Idempotency: the manifest is the ledger.
//   - a scenario whose `key` is already recorded is never created again;
//   - joins are recorded per participant and re-checked against the contract,
//     so a re-run after an interruption resumes rather than reverting on
//     AlreadyJoined.
//
// Usage:
//   npm run seed:demo:sepolia:dry
//   npm run seed:demo:sepolia

const { ethers, network } = require("hardhat");

const {
  SEPOLIA_CHAIN_ID,
  readManifest,
  writeManifest,
} = require("./lib/manifest");

const { SCENARIOS, buildAllocation } = require("./lib/scenarios");
const {
  deriveDemoAccounts,
  participantsForScenario,
} = require("./lib/demo-accounts");
const {
  BUDGET_ETH,
  assertWithinBudget,
  pricePlan,
  printPlan,
  worstCaseFeePerGas,
} = require("./lib/budget");

const EXPLORER = "https://sepolia.etherscan.io";

/** Gas float per demo wallet. Covers several joins plus a withdrawal. */
const PARTICIPANT_GAS_FLOAT = ethers.parseEther("0.0015");

/** Only top a wallet up if it falls below this. */
const PARTICIPANT_GAS_FLOOR = ethers.parseEther("0.0006");

const assertSepolia = async () => {
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);

  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      "Refusing to seed: connected to chainId " +
        chainId +
        ' via hardhat network "' +
        network.name +
        '", but the portfolio demo environment requires Sepolia (' +
        SEPOLIA_CHAIN_ID +
        ")."
    );
  }

  return chainId;
};

const splitAddressFromReceipt = (factory, receipt) => {
  for (const log of receipt.logs) {
    let parsed;

    try {
      parsed = factory.interface.parseLog(log);
    } catch {
      continue;
    }

    if (parsed && parsed.name === "SplitCreated") {
      return parsed.args.splitAddress;
    }
  }

  throw new Error("createSplit succeeded but no SplitCreated event was found.");
};

async function main() {
  const dryRun =
    process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");

  console.log("==========================================");
  console.log("Seed portfolio demo scenarios");
  console.log("==========================================");

  const chainId = await assertSepolia();
  const [deployer] = await ethers.getSigners();
  const manifest = readManifest();

  if (!manifest.factoryAddress) {
    throw new Error("Manifest has no factoryAddress. Deploy first.");
  }

  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Chain ID:  ", chainId);
  console.log("Factory:   ", manifest.factoryAddress);
  console.log("Deployer:  ", deployer.address);
  console.log("Balance:   ", ethers.formatEther(balance), "ETH");

  // Only the public addresses are ever logged; the phrase and keys are not.
  const pool = deriveDemoAccounts(process.env.DEMO_MNEMONIC).map((wallet) =>
    wallet.connect(ethers.provider)
  );

  console.log("Demo wallets:");
  pool.forEach((wallet, index) =>
    console.log("  [" + index + "] " + wallet.address)
  );
  console.log("------------------------------------------");

  const factory = await ethers.getContractAt(
    "SplitFactory",
    manifest.factoryAddress
  );

  const alreadySeeded = new Set(manifest.splits.map((split) => split.key));
  const pending = SCENARIOS.filter(
    (scenario) => !alreadySeeded.has(scenario.key)
  );

  if (pending.length === 0) {
    console.log("All scenarios are already recorded in the manifest.");
    console.log("Nothing to do — the seed script is idempotent.");
    console.log("==========================================");
    return;
  }

  console.log(
    alreadySeeded.size +
      " scenario(s) already seeded, " +
      pending.length +
      " pending:"
  );
  pending.forEach((scenario) =>
    console.log(
      "  - " + scenario.title + " (" + scenario.participantCount + " participants)"
    )
  );

  // Price everything before broadcasting any of it.
  const feePerGas = await worstCaseFeePerGas();
  const estimates = [];

  const walletsNeedingFloat = [];

  for (const wallet of pool) {
    const walletBalance = await ethers.provider.getBalance(wallet.address);

    if (walletBalance < PARTICIPANT_GAS_FLOOR) {
      walletsNeedingFloat.push(wallet);
      estimates.push({
        label: `gas float -> ${wallet.address.slice(0, 10)}...`,
        gas: 21000n,
      });
    }
  }

  let totalJoins = 0;

  for (const scenario of pending) {
    const gas = await factory.createSplit.estimateGas(scenario.title);
    estimates.push({ label: `createSplit "${scenario.title}"`, gas });
    totalJoins += scenario.participantCount;
  }

  // join() gas is measured from the contract tests: ~115k for the first
  // participant in a split (cold storage), ~81k thereafter. Use the high figure
  // for every join so the worst case is never understated.
  estimates.push({
    label: `${totalJoins} x participant join (worst case)`,
    gas: 115000n * BigInt(totalJoins),
  });

  const plan = pricePlan(estimates, feePerGas);
  printPlan(plan, feePerGas, balance);

  // The floats themselves are ETH leaving the wallet, on top of gas.
  const floatTotal = PARTICIPANT_GAS_FLOAT * BigInt(walletsNeedingFloat.length);

  console.log(
    "  Gas floats to send:         " +
      ethers.formatEther(floatTotal) +
      " ETH (" +
      walletsNeedingFloat.length +
      " wallets)"
  );
  console.log(
    "  Total ETH leaving wallet:   " +
      ethers.formatEther(plan.totalWei + floatTotal) +
      " ETH"
  );
  console.log("");

  const combined = { ...plan, totalWei: plan.totalWei + floatTotal };

  if (!assertWithinBudget(combined, balance, pending.length)) {
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("DRY RUN — nothing will be broadcast.");
    console.log("");

    pending.forEach((scenario) => {
      const participants = participantsForScenario(
        pool,
        scenario.participantCount
      );

      console.log(scenario.title);
      console.log("  createSplit + " + participants.length + " joins");
      participants.forEach((wallet) => console.log("    " + wallet.address));
    });

    console.log("");
    console.log("==========================================");
    return;
  }

  console.log(`Within the ${BUDGET_ETH} ETH budget — proceeding.`);
  console.log("------------------------------------------");

  // Top up wallets before any joins, so a join can never fail for gas.
  for (const wallet of walletsNeedingFloat) {
    console.log("Funding gas float -> " + wallet.address);
    const topUp = await deployer.sendTransaction({
      to: wallet.address,
      value: PARTICIPANT_GAS_FLOAT,
    });
    await topUp.wait();
  }

  for (const scenario of pending) {
    console.log("");
    console.log(">>> " + scenario.title);

    const participants = participantsForScenario(
      pool,
      scenario.participantCount
    );

    const createTx = await factory.createSplit(scenario.title);
    const createReceipt = await createTx.wait();
    const splitAddress = splitAddressFromReceipt(factory, createReceipt);

    console.log(
      "    created " + splitAddress + " (block " + createReceipt.blockNumber + ")"
    );

    const split = await ethers.getContractAt("EthSplit", splitAddress);

    const record = {
      key: scenario.key,
      title: scenario.title,
      description: scenario.description,
      splitAddress,
      manager: deployer.address,
      creationTxHash: createReceipt.hash,
      creationBlockNumber: createReceipt.blockNumber,
      participants: participants.map((wallet) => wallet.address),
      onChainParticipantCount: 0,
      allocation: buildAllocation(scenario),
      demoStatus: "created",
      lifecycle: {
        joins: [],
        funding: null,
        finalization: null,
        withdrawals: [],
      },
      explorer: {
        split: EXPLORER + "/address/" + splitAddress,
        creationTx: EXPLORER + "/tx/" + createReceipt.hash,
      },
    };

    for (const wallet of participants) {
      // Re-check the chain rather than trusting the manifest alone, so an
      // interrupted run cannot revert here with AlreadyJoined.
      if (await split.isParticipant(wallet.address)) {
        console.log("    already joined " + wallet.address + " — skipping");
        continue;
      }

      const joinTx = await split.connect(wallet).join();
      const joinReceipt = await joinTx.wait();

      record.lifecycle.joins.push({
        participant: wallet.address,
        txHash: joinReceipt.hash,
        blockNumber: joinReceipt.blockNumber,
      });

      console.log("    joined  " + wallet.address);
    }

    record.onChainParticipantCount = Number(await split.participantCount());
    record.demoStatus = record.onChainParticipantCount > 0 ? "active" : "created";

    // Persist after every scenario so an interrupted run stays idempotent.
    manifest.splits.push(record);
    manifest.seededAt = new Date().toISOString();
    writeManifest(manifest);

    console.log(
      "    recorded (" +
        record.onChainParticipantCount +
        " participants on-chain, status: " +
        record.demoStatus +
        ")"
    );
  }

  const [, deployedSplits] = await factory.getFactoryInfo();

  console.log("");
  console.log("------------------------------------------");
  console.log("Factory now reports " + deployedSplits.toString() + " splits");

  manifest.splits.forEach((split) => {
    console.log(
      "  " +
        split.title.padEnd(30) +
        split.splitAddress +
        "  [" +
        split.demoStatus +
        ", " +
        split.onChainParticipantCount +
        "p]"
    );
  });

  console.log("");
  console.log("Next: npm run lifecycle:demo:sepolia");
  console.log("==========================================");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
