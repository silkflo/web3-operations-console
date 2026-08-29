// ethereum-v3/test/invariant/EthSplit.invariant.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EthSplit - Invariant Tests", function () {
  // Test fixtures
  async function deployEthSplit() {
    const [manager, ...participants] = await ethers.getSigners();
    const EthSplit = await ethers.getContractFactory("EthSplit");
    const split = await EthSplit.deploy("Invariant Test", manager.address);
    await split.waitForDeployment();
    return { split, manager, participants };
  }

  describe("Conservation of Funds", function () {
    it("INVARIANT: totalClaimable + roundPool should always equal contractBalance", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];
      const charlie = participants[2];

      // Perform multiple rounds
      for (let round = 0; round < 10; round++) {
        // Join participants
        await split.connect(alice).join();
        await split.connect(bob).join();
        if (round % 2 === 0) {
          await split.connect(charlie).join();
        }

        // Fund random amount
        const amount = ethers.parseEther((round + 1).toString());
        await split.connect(manager).fund({ value: amount });

        // Finalize
        await split.connect(manager).finalizeDistribution();

        // Check invariant
        const totalClaimable = await split.totalClaimable();
        const roundPool = await split.roundPool();
        const contractBalance = await split.contractBalance();

        expect(totalClaimable + roundPool).to.equal(
          contractBalance,
          `Invariant violated at round ${round}: claimable=${totalClaimable}, pool=${roundPool}, balance=${contractBalance}`
        );

        // Withdraw some funds
        if (round % 3 === 0) {
          await split.connect(alice).withdraw();
        }

        // Check invariant again after withdrawal
        const totalClaimableAfter = await split.totalClaimable();
        const roundPoolAfter = await split.roundPool();
        const contractBalanceAfter = await split.contractBalance();

        expect(totalClaimableAfter + roundPoolAfter).to.equal(
          contractBalanceAfter,
          `Invariant violated after withdrawal: claimable=${totalClaimableAfter}, pool=${roundPoolAfter}, balance=${contractBalanceAfter}`
        );
      }
    });

    it("INVARIANT: contract balance should never exceed total funds ever deposited", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];
      let totalDeposited = 0n;

      // Multiple rounds
      for (let round = 0; round < 5; round++) {
        await split.connect(alice).join();
        await split.connect(bob).join();

        const amount = ethers.parseEther("2");
        totalDeposited += amount;

        await split.connect(manager).fund({ value: amount });
        await split.connect(manager).finalizeDistribution();

        // Contract balance should never exceed total deposits
        const contractBalance = await split.contractBalance();
        expect(contractBalance).to.be.lessThanOrEqual(totalDeposited);

        // Withdraw
        await split.connect(alice).withdraw();
        await split.connect(bob).withdraw();
      }

      // After all withdrawals, contract should be empty
      expect(await split.contractBalance()).to.equal(0);
    });
  });

  describe("Participant Integrity", function () {
    it("INVARIANT: participantCount should always match participantsList length", async function () {
      const { split, participants } = await deployEthSplit();

      // Join random number of participants
      const count = 5;
      for (let i = 0; i < count; i++) {
        await split.connect(participants[i]).join();

        // After each join, verify invariant
        const participantCount = await split.participantCount();
        const participantList = await split.getParticipants();

        expect(participantCount).to.equal(participantList.length);
        expect(participantCount).to.equal(i + 1);
      }
    });

    it("INVARIANT: participants should always be reset after finalization", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      // Round 1
      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      // After finalization, participant list should be empty
      expect(await split.participantCount()).to.equal(0);
      expect(await split.getParticipants()).to.deep.equal([]);
      expect(await split.isParticipant(alice.address)).to.equal(false);
      expect(await split.isParticipant(bob.address)).to.equal(false);
    });
  });

  describe("Claimable Balance Integrity", function () {
    it("INVARIANT: individual claimable should never exceed totalClaimable", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      const aliceClaimable = await split.claimable(alice.address);
      const bobClaimable = await split.claimable(bob.address);
      const totalClaimable = await split.totalClaimable();

      // Each individual claim should be less than or equal to total
      expect(aliceClaimable).to.be.lessThanOrEqual(totalClaimable);
      expect(bobClaimable).to.be.lessThanOrEqual(totalClaimable);

      // Sum of individual claims should equal total
      expect(aliceClaimable + bobClaimable).to.equal(totalClaimable);
    });

    it("INVARIANT: withdrawal should reduce totalClaimable by exact amount", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      const beforeClaimable = await split.claimable(alice.address);
      const beforeTotal = await split.totalClaimable();

      await split.connect(alice).withdraw();

      const afterTotal = await split.totalClaimable();

      expect(afterTotal).to.equal(beforeTotal - beforeClaimable);
    });
  });

  describe("Round Management", function () {
    it("INVARIANT: round should only increment after finalization", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      expect(await split.round()).to.equal(1);

      // Joining doesn't change round
      await split.connect(alice).join();
      await split.connect(bob).join();
      expect(await split.round()).to.equal(1);

      // Funding doesn't change round
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      expect(await split.round()).to.equal(1);

      // Finalizing increments round
      await split.connect(manager).finalizeDistribution();
      expect(await split.round()).to.equal(2);

      // Withdrawal doesn't change round
      await split.connect(alice).withdraw();
      expect(await split.round()).to.equal(2);
    });

    it("INVARIANT: roundPool should be zero after full distribution", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      await split.connect(alice).join();
      await split.connect(bob).join();

      // Fund exactly divisible amount
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      // Round pool should be zero (no remainder)
      expect(await split.roundPool()).to.equal(0);

      // Available for distribution should be zero
      expect(await split.availableForDistribution()).to.equal(0);
    });
  });

  describe("Access Control Invariants", function () {
    it("INVARIANT: manager should never change", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const originalManager = await split.manager();
      expect(originalManager).to.equal(manager.address);

      // Perform operations
      await split.connect(participants[0]).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      // Manager should still be the same
      expect(await split.manager()).to.equal(manager.address);
      expect(await split.manager()).to.equal(originalManager);
    });

    it("INVARIANT: only manager can change round state", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      await split.connect(alice).join();

      // Non-manager attempts to fund should fail
      await expect(
        split.connect(alice).fund({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(split, "OnlyManager");

      // Non-manager attempts to finalize should fail
      await expect(
        split.connect(alice).finalizeDistribution()
      ).to.be.revertedWithCustomError(split, "OnlyManager");

      // Round state should remain unchanged
      expect(await split.round()).to.equal(1);
      expect(await split.roundPool()).to.equal(0);
    });
  });

  describe("Multiple Round Invariants", function () {
    it("INVARIANT: accumulated claims should be correct across rounds", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      // Round 1: Alice and Bob
      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      const aliceRound1 = await split.claimable(alice.address);
      expect(aliceRound1).to.equal(ethers.parseEther("0.5"));

      // Round 2: Only Alice
      await split.connect(alice).join();
      await split.connect(manager).fund({ value: ethers.parseEther("0.3") });
      await split.connect(manager).finalizeDistribution();

      const aliceRound2 = await split.claimable(alice.address);
      expect(aliceRound2).to.equal(ethers.parseEther("0.8")); // 0.5 + 0.3

      // Bob's claim unchanged from round 1
      const bobFinal = await split.claimable(bob.address);
      expect(bobFinal).to.equal(ethers.parseEther("0.5"));

      // Total claimable should be sum of individual claims
      const totalClaimable = await split.totalClaimable();
      expect(totalClaimable).to.equal(aliceRound2 + bobFinal);
    });
  });
});
