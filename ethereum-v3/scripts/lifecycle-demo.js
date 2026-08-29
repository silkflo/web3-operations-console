// ethereum-v3/scripts/lifecycle-demo.js
//
// Takes the configured scenario through the rest of its lifecycle: fund the
// round, finalize the distribution, and have one participant withdraw.
//
// Split out from seed-demo.js so each phase is priced and gated separately, and
// so an interruption never leaves the run somewhere it cannot resume from.
//
// Idempotency: every step is checked against the CONTRACT before it is sent.
//   - funding is skipped if the round pool already holds the target amount;
//   - finalization is skipped if the round has already advanced;
//   - a withdrawal is skipped if that participant's claimable is already zero.
// Re-running is a no-op once the lifecycle is complete.
//
// Note on EthSplit semantics: finalizeDistribution() clears participantsList and
// resets participantCount to 0, then increments `round`. A finalized split
// therefore reports 0 current participants even though addresses did join and
// hold claimable balances. That is the contract working as designed, not a bug.
//
// Usage:
//   npm run lifecycle:demo:sepolia:dry
//   npm run lifecycle:demo:sepolia

const { ethers, network } = require("hardhat");

const {
  SEPOLIA_CHAIN_ID,
  readManifest,
  writeManifest,
} = require("./lib/manifest");

const { SCENARIOS } = require("./lib/scenarios");
const { deriveDemoAccounts } = require("./lib/demo-accounts");
const {
  BUDGET_ETH,
  assertWithinBudget,
  pricePlan,
  printPlan,
  worstCaseFeePerGas,
} = require("./lib/budget");

const EXPLORER = "https://sepolia.etherscan.io";

const assertSepolia = async () => {
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);

  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      "Refusing to run the lifecycle: connected to chainId " +
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

async function main() {
  const dryRun =
    process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");

  console.log("==========================================");
  console.log("Demo lifecycle — fund / finalize / withdraw");
  console.log("==========================================");

  const chainId = await assertSepolia();
  const [deployer] = await ethers.getSigners();
  const manifest = readManifest();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Chain ID: ", chainId);
  console.log("Factory:  ", manifest.factoryAddress);
  console.log("Deployer: ", deployer.address);
  console.log("Balance:  ", ethers.formatEther(balance), "ETH");
  console.log("------------------------------------------");

  const pool = deriveDemoAccounts(process.env.DEMO_MNEMONIC).map((wallet) =>
    wallet.connect(ethers.provider)
  );

  const walletFor = (address) =>
    pool.find(
      (wallet) => wallet.address.toLowerCase() === address.toLowerCase()
    );

  // Only scenarios that ask for funding take part in this phase.
  const targets = [];

  for (const scenario of SCENARIOS.filter((s) => s.fundingEth)) {
    const record = manifest.splits.find((s) => s.key === scenario.key);

    if (!record) {
      throw new Error(
        `Scenario "${scenario.key}" is not in the manifest. Run the seed step first.`
      );
    }

    const split = await ethers.getContractAt("EthSplit", record.splitAddress);

    const [roundPool, round, totalClaimable] = await Promise.all([
      split.availableForDistribution(),
      split.round(),
      split.totalClaimable(),
    ]);

    targets.push({
      scenario,
      record,
      split,
      roundPool,
      round: Number(round),
      totalClaimable,
    });
  }

  if (targets.length === 0) {
    console.log("No scenario is configured for funding. Nothing to do.");
    console.log("==========================================");
    return;
  }

  // Work out what is actually outstanding, from the chain.
  const work = [];

  for (const target of targets) {
    const wanted = ethers.parseEther(target.scenario.fundingEth);
    const needsFunding = target.roundPool < wanted && target.round === 1;
    const needsFinalize = target.scenario.finalize && target.round === 1;

    const pendingWithdrawals = [];

    for (let i = 0; i < target.scenario.withdrawParticipants; i += 1) {
      const address = target.record.participants[i];
      const claimable = await target.split.getClaimable(address);

      if (claimable > 0n) {
        pendingWithdrawals.push({ address, claimable });
      }
    }

    work.push({ ...target, needsFunding, needsFinalize, pendingWithdrawals });

    console.log(target.scenario.title);
    console.log("  split:            " + target.record.splitAddress);
    console.log("  round:            " + target.round);
    console.log("  round pool:       " + ethers.formatEther(target.roundPool) + " ETH");
    console.log("  total claimable:  " + ethers.formatEther(target.totalClaimable) + " ETH");
    console.log("  needs funding:    " + needsFunding);
    console.log("  needs finalize:   " + needsFinalize);
    console.log("  pending withdraw: " + pendingWithdrawals.length);
  }

  const outstanding = work.filter(
    (item) =>
      item.needsFunding || item.needsFinalize || item.pendingWithdrawals.length
  );

  if (outstanding.length === 0) {
    console.log("");
    console.log("Lifecycle already complete on-chain. Nothing to do.");
    console.log("==========================================");
    return;
  }

  // Price the outstanding work.
  const feePerGas = await worstCaseFeePerGas();
  const estimates = [];
  let ethToSend = 0n;

  for (const item of outstanding) {
    if (item.needsFunding) {
      const amount = ethers.parseEther(item.scenario.fundingEth) - item.roundPool;
      ethToSend += amount;
      estimates.push({
        label: `fund ${item.scenario.fundingEth} ETH`,
        gas: await item.split.fund.estimateGas({ value: amount }),
      });
    }

    if (item.needsFinalize) {
      // Cannot estimate finalize before funding lands, so use the measured
      // figure from the contract tests with head-room.
      estimates.push({ label: "finalizeDistribution", gas: 140000n });
    }

    item.pendingWithdrawals.forEach((withdrawal) => {
      estimates.push({
        label: `withdraw ${withdrawal.address.slice(0, 10)}...`,
        gas: 45000n,
      });
    });
  }

  const plan = pricePlan(estimates, feePerGas);
  printPlan(plan, feePerGas, balance);

  console.log("  ETH funded into rounds:     " + ethers.formatEther(ethToSend) + " ETH");
  console.log(
    "  Total ETH leaving wallet:   " +
      ethers.formatEther(plan.totalWei + ethToSend) +
      " ETH"
  );
  console.log("");

  const combined = { ...plan, totalWei: plan.totalWei + ethToSend };

  if (!assertWithinBudget(combined, balance, outstanding.length)) {
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("DRY RUN — nothing will be broadcast.");
    console.log("==========================================");
    return;
  }

  console.log(`Within the ${BUDGET_ETH} ETH budget — proceeding.`);
  console.log("------------------------------------------");

  for (const item of outstanding) {
    console.log("");
    console.log(">>> " + item.scenario.title);

    if (item.needsFunding) {
      const amount = ethers.parseEther(item.scenario.fundingEth) - item.roundPool;
      const fundTx = await item.split.fund({ value: amount });
      const fundReceipt = await fundTx.wait();

      item.record.lifecycle.funding = {
        amountEth: ethers.formatEther(amount),
        txHash: fundReceipt.hash,
        blockNumber: fundReceipt.blockNumber,
        explorer: EXPLORER + "/tx/" + fundReceipt.hash,
      };

      console.log("    funded " + ethers.formatEther(amount) + " ETH");
      writeManifest(manifest);
    }

    if (item.needsFinalize) {
      const finalizeTx = await item.split.finalizeDistribution();
      const finalizeReceipt = await finalizeTx.wait();

      item.record.lifecycle.finalization = {
        txHash: finalizeReceipt.hash,
        blockNumber: finalizeReceipt.blockNumber,
        explorer: EXPLORER + "/tx/" + finalizeReceipt.hash,
      };

      item.record.demoStatus = "funded";

      console.log("    finalized distribution");
      writeManifest(manifest);
    }

    // Re-read claimable after finalization: it did not exist before.
    for (let i = 0; i < item.scenario.withdrawParticipants; i += 1) {
      const address = item.record.participants[i];
      const claimable = await item.split.getClaimable(address);

      if (claimable === 0n) {
        console.log("    nothing claimable for " + address + " — skipping");
        continue;
      }

      const wallet = walletFor(address);

      if (!wallet) {
        throw new Error(
          `No controlled wallet for participant ${address}; cannot withdraw.`
        );
      }

      const withdrawTx = await item.split.connect(wallet).withdraw();
      const withdrawReceipt = await withdrawTx.wait();

      item.record.lifecycle.withdrawals.push({
        participant: address,
        amountEth: ethers.formatEther(claimable),
        txHash: withdrawReceipt.hash,
        blockNumber: withdrawReceipt.blockNumber,
        explorer: EXPLORER + "/tx/" + withdrawReceipt.hash,
      });

      item.record.demoStatus = "withdrawn";

      console.log(
        "    withdrew " + ethers.formatEther(claimable) + " ETH to " + address
      );
      writeManifest(manifest);
    }

    // Refresh the recorded on-chain count; finalization resets it to 0.
    item.record.onChainParticipantCount = Number(
      await item.split.participantCount()
    );

    manifest.lifecycleAt = new Date().toISOString();
    writeManifest(manifest);
  }

  console.log("");
  console.log("------------------------------------------");

  for (const split of manifest.splits) {
    const contract = await ethers.getContractAt("EthSplit", split.splitAddress);
    const [round, participantCount, balanceWei, claimable] = await Promise.all([
      contract.round(),
      contract.participantCount(),
      contract.contractBalance(),
      contract.totalClaimable(),
    ]);

    console.log(
      "  " +
        split.title.padEnd(30) +
        "[" +
        split.demoStatus.padEnd(9) +
        "] round " +
        round +
        ", " +
        participantCount +
        "p, balance " +
        ethers.formatEther(balanceWei) +
        " ETH, claimable " +
        ethers.formatEther(claimable) +
        " ETH"
    );
  }

  console.log("");
  console.log("Next: npm run sync:frontend");
  console.log("==========================================");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
