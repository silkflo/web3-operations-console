// ethereum-v3/test/fuzz/EthSplit.fuzz.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EthSplit - Fuzz Tests", function () {
  // Test fixtures
  async function deployEthSplit() {
    const [manager, ...participants] = await ethers.getSigners();
    const EthSplit = await ethers.getContractFactory("EthSplit");
    const split = await EthSplit.deploy("Fuzz Test", manager.address);
    await split.waitForDeployment();
    return { split, manager, participants };
  }

  /**
   * Generates a random ETH amount between min and max
   * Uses deterministic pseudo-random based on test parameters
   */
  function randomAmount(seed, min = 1, max = 100) {
    const range = max - min;
    const random = (seed * 7919 + 104729) % range;
    const amount = min + random;
    return ethers.parseEther(amount.toString());
  }

  describe("Random Funding Amounts", function () {
    it("should handle any funding amount without breaking accounting", async function () {
      const { split, manager, participants } = await deployEthSplit();

      // Use 5 participants
      const activeParticipants = participants.slice(0, 5);

      // Run 20 random funding rounds
      for (let round = 0; round < 20; round++) {
        // Join random number of participants (1-5)
        const numParticipants = (round % 5) + 1;
        const roundParticipants = activeParticipants.slice(0, numParticipants);

        for (const participant of roundParticipants) {
          await split.connect(participant).join();
        }

        // Fund with random amount (1-100 ETH)
        const fundingAmount = randomAmount(round + 1);
        await split.connect(manager).fund({ value: fundingAmount });

        // Finalize
        await split.connect(manager).finalizeDistribution();

        // Verify accounting invariant
        const totalClaimable = await split.totalClaimable();
        const roundPool = await split.roundPool();
        const contractBalance = await split.contractBalance();

        // totalClaimable + roundPool should equal contractBalance
        expect(totalClaimable + roundPool).to.equal(contractBalance);

        // Verify each participant's claim is correct
        const expectedShare = fundingAmount / BigInt(numParticipants);
        for (const participant of roundParticipants) {
          const claimable = await split.claimable(participant.address);
          expect(claimable).to.be.greaterThanOrEqual(expectedShare);
        }
      }
    });

    it("should handle tiny funding amounts without losing funds", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      await split.connect(alice).join();
      await split.connect(bob).join();

      // Try various tiny amounts (must be at least 2 wei for 2 participants)
      const tinyAmounts = [2, 4, 10, 100, 1000];

      for (const amount of tinyAmounts) {
        const beforeBalance = await split.contractBalance();

        await split.connect(manager).fund({ value: amount });
        await split.connect(manager).finalizeDistribution();

        // Verify no funds are lost
        const afterBalance = await split.contractBalance();
        const totalClaimable = await split.totalClaimable();
        const roundPool = await split.roundPool();

        expect(afterBalance).to.equal(beforeBalance + BigInt(amount));
        expect(totalClaimable + roundPool).to.equal(afterBalance);

        // Rejoin for next round
        await split.connect(alice).join();
        await split.connect(bob).join();
      }
    });
  });

  describe("Random Participant Counts", function () {
    it("should handle varying participant counts correctly", async function () {
      const { split, manager, participants } = await deployEthSplit();

      // Test with different participant counts
      const counts = [1, 2, 3, 5, 10, 15, 19];

      for (const count of counts) {
        // Deploy fresh contract for each count
        const EthSplit = await ethers.getContractFactory("EthSplit");
        const newSplit = await EthSplit.deploy(`Fuzz ${count}`, manager.address);
        await newSplit.waitForDeployment();

        // Join participants
        const roundParticipants = participants.slice(0, count);
        for (const participant of roundParticipants) {
          await newSplit.connect(participant).join();
        }

        expect(await newSplit.participantCount()).to.equal(count);

        // Fund and finalize
        const fundingAmount = ethers.parseEther("1");
        await newSplit.connect(manager).fund({ value: fundingAmount });
        await newSplit.connect(manager).finalizeDistribution();

        // Verify each participant got correct share
        const expectedShare = fundingAmount / BigInt(count);

        for (const participant of roundParticipants) {
          const claimable = await newSplit.claimable(participant.address);
          expect(claimable).to.equal(expectedShare);
        }

        // Verify accounting
        const totalClaimable = await newSplit.totalClaimable();
        const roundPool = await newSplit.roundPool();
        const contractBalance = await newSplit.contractBalance();

        expect(totalClaimable + roundPool).to.equal(contractBalance);
      }
    });
  });

  describe("Random Withdrawal Patterns", function () {
    it("should handle random withdrawal order without breaking accounting", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];
      const charlie = participants[2];

      // Setup initial round
      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(charlie).join();

      await split.connect(manager).fund({ value: ethers.parseEther("1.5") });
      await split.connect(manager).finalizeDistribution();

      const expectedShare = ethers.parseEther("0.5");

      // Random withdrawal order
      const withdrawalOrder = [charlie, alice, bob];

      for (const participant of withdrawalOrder) {
        const beforeBalance = await split.contractBalance();
        const beforeClaimable = await split.claimable(participant.address);

        await split.connect(participant).withdraw();

        const afterBalance = await split.contractBalance();
        const afterClaimable = await split.claimable(participant.address);

        expect(afterClaimable).to.equal(0);
        expect(afterBalance).to.equal(beforeBalance - beforeClaimable);
      }

      // Contract should be empty
      expect(await split.contractBalance()).to.equal(0);
      expect(await split.totalClaimable()).to.equal(0);
    });

    it("should handle partial withdrawals across multiple rounds", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      // Round 1
      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      // Alice withdraws, Bob doesn't
      await split.connect(alice).withdraw();

      // Round 2
      await split.connect(alice).join();
      await split.connect(manager).fund({ value: ethers.parseEther("0.4") });
      await split.connect(manager).finalizeDistribution();

      // Alice has 0.4, Bob has 0.5
      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("0.4"));
      expect(await split.claimable(bob.address)).to.equal(ethers.parseEther("0.5"));

      // Both withdraw
      await split.connect(alice).withdraw();
      await split.connect(bob).withdraw();

      // Verify accounting
      expect(await split.totalClaimable()).to.equal(0);
      expect(await split.contractBalance()).to.equal(0);
    });
  });

  describe("Random Operation Sequences", function () {
    it("should maintain invariants under random operations", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const activeParticipants = participants.slice(0, 3);

      // Perform 30 random operations
      for (let i = 0; i < 30; i++) {
        const operation = i % 4;
        const participant = activeParticipants[i % 3];

        switch (operation) {
          case 0: // Join
            if (!(await split.isParticipant(participant.address))) {
              await split.connect(participant).join();
            }
            break;

          case 1: // Fund
            if ((await split.participantCount()) > 0) {
              const amount = randomAmount(i + 10);
              await split.connect(manager).fund({ value: amount });
            }
            break;

          case 2: // Finalize
            if (
              (await split.participantCount()) > 0 &&
              (await split.roundPool()) > 0
            ) {
              await split.connect(manager).finalizeDistribution();
            }
            break;

          case 3: // Withdraw
            const claimable = await split.claimable(participant.address);
            if (claimable > 0) {
              await split.connect(participant).withdraw();
            }
            break;
        }

        // After each operation, verify accounting
        const totalClaimable = await split.totalClaimable();
        const roundPool = await split.roundPool();
        const contractBalance = await split.contractBalance();

        expect(totalClaimable + roundPool).to.equal(contractBalance);
      }
    });
  });

  describe("Boundary Value Tests", function () {
    it("should handle participant limit with available signers", async function () {
      const { split, participants } = await deployEthSplit();

      // Join all available participants (19 signers after manager)
      for (let i = 0; i < participants.length; i++) {
        await split.connect(participants[i]).join();
      }

      expect(await split.participantCount()).to.equal(participants.length);
    });

    it("should handle very large funding amounts", async function () {
      const { split, manager, participants } = await deployEthSplit();

      const alice = participants[0];
      const bob = participants[1];

      await split.connect(alice).join();
      await split.connect(bob).join();

      // Fund with very large amount (1000 ETH)
      const largeAmount = ethers.parseEther("1000");
      await split.connect(manager).fund({ value: largeAmount });
      await split.connect(manager).finalizeDistribution();

      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("500"));
      expect(await split.claimable(bob.address)).to.equal(ethers.parseEther("500"));

      // Verify accounting
      expect(await split.totalClaimable()).to.equal(largeAmount);
      expect(await split.contractBalance()).to.equal(largeAmount);
    });
  });
});
