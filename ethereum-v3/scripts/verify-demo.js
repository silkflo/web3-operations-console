// ethereum-v3/scripts/verify-demo.js
//
// Independently verifies the deployed demo environment against Sepolia.
//
// Reads every figure back from the chain and compares it to the manifest and to
// what the scenario definitions say should be true. Read-only: it broadcasts
// nothing and can be re-run at any time.
//
// Usage:
//   npm run verify:demo:sepolia

const { ethers, network } = require("hardhat");

const { SEPOLIA_CHAIN_ID, readManifest, validateManifest } = require("./lib/manifest");
const { SCENARIOS } = require("./lib/scenarios");

let failures = 0;

const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);

  if (!ok) {
    failures += 1;
  }

  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(42)} ${
      ok ? String(actual) : `got ${actual}, expected ${expected}`
    }`
  );
};

async function main() {
  console.log("==================================================");
  console.log("Verify demo environment against Sepolia (read-only)");
  console.log("==================================================");

  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);

  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Verification must run against Sepolia; connected to ${chainId} via "${network.name}".`
    );
  }

  const manifest = readManifest();

  console.log("\n[manifest schema]");
  try {
    validateManifest(manifest);
    console.log("  PASS  manifest validates against the schema");
  } catch (error) {
    failures += 1;
    console.log("  FAIL  " + error.message);
  }

  console.log("\n[factory]");

  const code = await ethers.provider.getCode(manifest.factoryAddress);
  check("factory has bytecode", code !== "0x", true);

  const factory = await ethers.getContractAt(
    "SplitFactory",
    manifest.factoryAddress
  );

  const [version, deployedSplits, defaultPageSize, maxPageSize] =
    await factory.getFactoryInfo();

  check("factory version", version, "3.0.0");
  check("factory version matches manifest", version, manifest.factoryVersion);
  check("deployed split count", deployedSplits, SCENARIOS.length);
  check("default page size", defaultPageSize, 20);
  check("max page size", maxPageSize, 100);

  const receipt = await ethers.provider.getTransactionReceipt(
    manifest.deploymentTxHash
  );

  check("deployment tx found", receipt !== null, true);
  check("deployment tx status", receipt.status, 1);
  check("deployment block", receipt.blockNumber, manifest.deploymentBlockNumber);
  check(
    "deployer matches manifest",
    receipt.from.toLowerCase(),
    manifest.deployerAddress.toLowerCase()
  );
  check(
    "created contract matches manifest",
    receipt.contractAddress.toLowerCase(),
    manifest.factoryAddress.toLowerCase()
  );

  // The factory's own index must agree with the manifest, split for split.
  const [indexed, total] = await factory.getSplits(0);

  check("factory index length", indexed.length, SCENARIOS.length);
  check("factory reported total", total, SCENARIOS.length);

  for (const scenario of SCENARIOS) {
    const record = manifest.splits.find((split) => split.key === scenario.key);

    console.log(`\n[${scenario.title}]`);

    if (!record) {
      failures += 1;
      console.log("  FAIL  not present in the manifest");
      continue;
    }

    const split = await ethers.getContractAt("EthSplit", record.splitAddress);

    const onChain = indexed.find(
      (entry) =>
        entry.splitAddress.toLowerCase() === record.splitAddress.toLowerCase()
    );

    check("tracked by the factory", Boolean(onChain), true);
    check(
      "factory confirms it deployed this",
      await factory.isDeployedByFactory(record.splitAddress),
      true
    );

    check("title", await split.title(), scenario.title);
    check("contract version", await split.VERSION(), "3.0.0");
    check(
      "manager is the deployer",
      (await split.manager()).toLowerCase(),
      manifest.deployerAddress.toLowerCase()
    );

    const creationReceipt = await ethers.provider.getTransactionReceipt(
      record.creationTxHash
    );
    check("creation tx status", creationReceipt.status, 1);
    check(
      "creation block matches manifest",
      creationReceipt.blockNumber,
      record.creationBlockNumber
    );

    // Every recorded participant must really have joined, evidenced by its own
    // successful transaction.
    check(
      "recorded participant count",
      record.participants.length,
      scenario.participantCount
    );
    check("join transactions recorded", record.lifecycle.joins.length, scenario.participantCount);

    for (const join of record.lifecycle.joins) {
      const joinReceipt = await ethers.provider.getTransactionReceipt(
        join.txHash
      );
      check(
        `join by ${join.participant.slice(0, 10)}... succeeded`,
        joinReceipt && joinReceipt.status,
        1
      );
      check(
        `join sender is the participant`,
        joinReceipt.from.toLowerCase(),
        join.participant.toLowerCase()
      );
    }

    const round = Number(await split.round());
    const participantCount = Number(await split.participantCount());
    const balance = await split.contractBalance();
    const claimable = await split.totalClaimable();
    const pool = await split.availableForDistribution();

    if (scenario.finalize) {
      // finalizeDistribution() clears the participant list and bumps the round.
      const share = ethers.parseEther(scenario.fundingEth) / BigInt(scenario.participantCount);
      const withdrawn = BigInt(scenario.withdrawParticipants) * share;

      check("round advanced after finalize", round, 2);
      check("current participants reset to 0", participantCount, 0);
      check("funding tx recorded", Boolean(record.lifecycle.funding), true);
      check("finalization recorded", Boolean(record.lifecycle.finalization), true);
      check(
        "withdrawals recorded",
        record.lifecycle.withdrawals.length,
        scenario.withdrawParticipants
      );
      check(
        "total claimable equals unwithdrawn shares",
        claimable,
        share * BigInt(scenario.participantCount) - withdrawn
      );
      check(
        "contract balance equals claimable plus dust",
        balance,
        claimable + pool
      );

      // The withdrawer's claimable must now be zero, and the others' must not.
      for (let i = 0; i < record.participants.length; i += 1) {
        const address = record.participants[i];
        const remaining = await split.getClaimable(address);
        check(
          `claimable for participant ${i + 1}`,
          remaining,
          i < scenario.withdrawParticipants ? 0n : share
        );
      }

      for (const withdrawal of record.lifecycle.withdrawals) {
        const withdrawReceipt = await ethers.provider.getTransactionReceipt(
          withdrawal.txHash
        );
        check("withdrawal tx status", withdrawReceipt.status, 1);
        check(
          "withdrawal sender is the participant",
          withdrawReceipt.from.toLowerCase(),
          withdrawal.participant.toLowerCase()
        );
      }
    } else {
      check("still on round 1", round, 1);
      check("participants still joined", participantCount, scenario.participantCount);
      check("balance is zero", balance, 0n);
      check("nothing claimable", claimable, 0n);
      check("not funded", Boolean(record.lifecycle.funding), false);
    }

    check(
      "manifest participant count matches chain",
      record.onChainParticipantCount,
      participantCount
    );

    console.log("  link  " + record.explorer.split);
  }

  console.log("\n==================================================");

  if (failures === 0) {
    console.log("ALL CHECKS PASSED");
  } else {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  }

  console.log("==================================================");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
