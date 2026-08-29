// ethereum-v3/test/demo/Scenarios.test.js
//
// The demo scenarios are a contract between the seed script, the manifest and
// the dashboard. These tests pin their shape, and prove that createSplit works
// for each title against the real V3 contracts.
//
// Scope is the full lifecycle: every scenario is created and joined; exactly
// one is funded, finalized and partially withdrawn.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const {
  SCENARIOS,
  buildAllocation,
  equalSharePercent,
} = require("../../scripts/lib/scenarios");

const {
  DEMO_ACCOUNT_COUNT,
  deriveDemoAccounts,
  participantsForScenario,
} = require("../../scripts/lib/demo-accounts");

// Well-known throwaway test mnemonic, published in the Hardhat/Foundry docs.
// Never funded on mainnet; used here only to prove deterministic derivation.
const TEST_MNEMONIC =
  "test test test test test test test test test test test junk";

describe("Demo — scenario definitions", function () {
  it("defines exactly three scenarios", function () {
    expect(SCENARIOS).to.have.lengthOf(3);
  });

  it("uses the expected titles, in order", function () {
    expect(SCENARIOS.map((s) => s.title)).to.deep.equal([
      "Creator Revenue Share",
      "Product Team Bonus",
      "Project Partner Settlement",
    ]);
  });

  it("uses unique keys", function () {
    const keys = SCENARIOS.map((s) => s.key);
    expect(new Set(keys).size).to.equal(keys.length);
  });

  it("matches the participant counts the brief asked for", function () {
    const byKey = Object.fromEntries(SCENARIOS.map((s) => [s.key, s]));

    expect(byKey["creator-revenue-share"].participantCount).to.be.within(3, 4);
    expect(byKey["product-team-bonus"].participantCount).to.equal(4);
    expect(byKey["project-partner-settlement"].participantCount).to.equal(3);
  });

  it("never exceeds the demo wallet pool", function () {
    SCENARIOS.forEach((scenario) => {
      expect(scenario.participantCount).to.be.at.most(DEMO_ACCOUNT_COUNT);
    });
  });

  it("funds exactly one scenario", function () {
    const funded = SCENARIOS.filter((scenario) => scenario.fundingEth);

    expect(funded).to.have.lengthOf(1);
    expect(funded[0].key).to.equal("creator-revenue-share");
    expect(funded[0].fundingEth).to.equal("0.001");
  });

  it("only withdraws from a scenario that is also finalized", function () {
    // withdraw() needs a claimable balance, which only finalize() creates.
    SCENARIOS.forEach((scenario) => {
      if (scenario.withdrawParticipants > 0) {
        expect(scenario.finalize, `${scenario.key} must finalize`).to.equal(true);
      }
      if (scenario.finalize) {
        expect(scenario.fundingEth, `${scenario.key} must be funded`).to.be.a(
          "string"
        );
      }
    });
  });

  it("performs exactly one withdrawal across the whole demo", function () {
    const total = SCENARIOS.reduce(
      (sum, scenario) => sum + scenario.withdrawParticipants,
      0
    );
    expect(total).to.equal(1);
  });

  it("leaves at least one scenario joined but unfunded", function () {
    const unfunded = SCENARIOS.filter(
      (scenario) => !scenario.fundingEth && scenario.participantCount > 0
    );
    expect(unfunded.length).to.be.at.least(1);
  });

  it("describes an equal allocation model, matching the contract", function () {
    SCENARIOS.forEach((scenario) => {
      const allocation = buildAllocation(scenario);
      expect(allocation.model).to.equal("equal");
      expect(allocation.participantCount).to.equal(scenario.participantCount);
    });

    expect(equalSharePercent(3)).to.equal("33.33%");
    expect(equalSharePercent(4)).to.equal("25.00%");
  });
});

describe("Demo — controlled participant wallets", function () {
  it("derives deterministically from a mnemonic", function () {
    const first = deriveDemoAccounts(TEST_MNEMONIC).map((w) => w.address);
    const second = deriveDemoAccounts(TEST_MNEMONIC).map((w) => w.address);

    expect(first).to.deep.equal(second);
    expect(first).to.have.lengthOf(DEMO_ACCOUNT_COUNT);
  });

  it("derives distinct addresses", function () {
    const addresses = deriveDemoAccounts(TEST_MNEMONIC).map((w) => w.address);
    expect(new Set(addresses).size).to.equal(addresses.length);
  });

  it("rejects a missing or empty mnemonic", function () {
    expect(() => deriveDemoAccounts(undefined)).to.throw(/not set/);
    expect(() => deriveDemoAccounts("   ")).to.throw(/not set/);
  });

  it("rejects an invalid mnemonic", function () {
    expect(() => deriveDemoAccounts("not a real mnemonic phrase")).to.throw(
      /not a valid BIP-39/
    );
  });

  it("refuses a scenario larger than the pool", function () {
    const pool = deriveDemoAccounts(TEST_MNEMONIC);
    expect(() => participantsForScenario(pool, DEMO_ACCOUNT_COUNT + 1)).to.throw(
      /only has/
    );
  });

  it("is large enough for the biggest scenario", function () {
    const biggest = Math.max(...SCENARIOS.map((s) => s.participantCount));
    expect(DEMO_ACCOUNT_COUNT).to.be.at.least(biggest);
  });
});

describe("Demo — full lifecycle against real contracts", function () {
  // Proves the exact step sequence the seed and lifecycle scripts perform is
  // valid for the real V3 contracts, before any Sepolia ETH is spent.
  async function deployFactory() {
    const signers = await ethers.getSigners();
    const SplitFactory = await ethers.getContractFactory("SplitFactory");
    const factory = await SplitFactory.deploy();
    await factory.waitForDeployment();
    return { factory, manager: signers[0], pool: signers.slice(1, 5) };
  }

  const splitFrom = (factory, receipt) =>
    receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "SplitCreated");

  it("reaches the exact end state the manifest will describe", async function () {
    const { factory, manager, pool } = await deployFactory();
    const results = [];

    for (const scenario of SCENARIOS) {
      const receipt = await (await factory.createSplit(scenario.title)).wait();
      const created = splitFrom(factory, receipt);

      expect(created, `${scenario.key} should emit SplitCreated`).to.not.be
        .undefined;

      const split = await ethers.getContractAt(
        "EthSplit",
        created.args.splitAddress
      );

      expect(await split.title()).to.equal(scenario.title);
      expect(await split.manager()).to.equal(manager.address);

      const joined = pool.slice(0, scenario.participantCount);

      for (const wallet of joined) {
        await split.connect(wallet).join();
      }

      expect(await split.participantCount()).to.equal(
        scenario.participantCount
      );

      if (scenario.fundingEth) {
        await split.fund({ value: ethers.parseEther(scenario.fundingEth) });
        expect(await split.availableForDistribution()).to.equal(
          ethers.parseEther(scenario.fundingEth)
        );
      }

      if (scenario.finalize) {
        await split.finalizeDistribution();

        // finalizeDistribution() clears the participant list and bumps the
        // round, so the split now reports 0 current participants.
        expect(await split.round()).to.equal(2);
        expect(await split.participantCount()).to.equal(0);

        const expectedShare =
          ethers.parseEther(scenario.fundingEth) /
          BigInt(scenario.participantCount);

        for (const wallet of joined) {
          expect(await split.getClaimable(wallet.address)).to.equal(
            expectedShare
          );
        }
      }

      for (let i = 0; i < scenario.withdrawParticipants; i += 1) {
        await split.connect(joined[i]).withdraw();
        expect(await split.getClaimable(joined[i].address)).to.equal(0);
      }

      results.push({ scenario, split, joined });
    }

    const [version, deployedSplits] = await factory.getFactoryInfo();
    expect(version).to.equal("3.0.0");
    expect(deployedSplits).to.equal(SCENARIOS.length);

    // The three distinct end states the dashboard is meant to show.
    const [creator, bonus, settlement] = results;

    expect(await creator.split.round(), "funded split advanced").to.equal(2);
    expect(await creator.split.participantCount()).to.equal(0);

    // Equal division of 0.001 ETH by 3 truncates: each share is
    // 333333333333333 wei and 1 wei of dust stays in the round pool for the
    // next round. After one withdrawal, exactly two shares remain claimable.
    const share = ethers.parseEther("0.001") / 3n;

    expect(
      await creator.split.totalClaimable(),
      "two unwithdrawn shares remain"
    ).to.equal(share * 2n);

    expect(
      await creator.split.availableForDistribution(),
      "1 wei of division dust carries to the next round"
    ).to.equal(ethers.parseEther("0.001") - share * 3n);

    expect(await bonus.split.round(), "unfunded split still round 1").to.equal(1);
    expect(await bonus.split.participantCount()).to.equal(4);
    expect(await bonus.split.contractBalance()).to.equal(0);

    expect(await settlement.split.round()).to.equal(1);
    expect(await settlement.split.participantCount()).to.equal(3);
    expect(await settlement.split.contractBalance()).to.equal(0);
  });

  it("distributes equally, confirming the allocation model we publish", async function () {
    const { factory, pool } = await deployFactory();
    const receipt = await (await factory.createSplit("Equal Check")).wait();
    const split = await ethers.getContractAt(
      "EthSplit",
      splitFrom(factory, receipt).args.splitAddress
    );

    for (const wallet of pool) {
      await split.connect(wallet).join();
    }

    await split.fund({ value: ethers.parseEther("0.004") });
    await split.finalizeDistribution();

    for (const wallet of pool) {
      expect(await split.getClaimable(wallet.address)).to.equal(
        ethers.parseEther("0.001")
      );
    }
  });

  it("refuses a second join from the same address in one round", async function () {
    // This is why the seed script re-checks isParticipant before joining.
    const { factory, pool } = await deployFactory();
    const receipt = await (await factory.createSplit("Rejoin Check")).wait();
    const split = await ethers.getContractAt(
      "EthSplit",
      splitFrom(factory, receipt).args.splitAddress
    );

    await split.connect(pool[0]).join();

    await expect(split.connect(pool[0]).join()).to.be.revertedWithCustomError(
      split,
      "AlreadyJoined"
    );
  });
});
