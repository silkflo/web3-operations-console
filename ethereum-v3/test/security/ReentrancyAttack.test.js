// ethereum-v3/test/security/ReentrancyAttack.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Security Tests - Reentrancy & Attack Vectors", function () {
  // Test fixtures
  async function deployVulnerableSetup() {
    const [manager, alice, bob, charlie] = await ethers.getSigners();

    // Deploy EthSplit
    const EthSplit = await ethers.getContractFactory("EthSplit");
    const split = await EthSplit.deploy("Security Test", manager.address);
    await split.waitForDeployment();

    // Deploy MaliciousAttacker
    const MaliciousAttacker = await ethers.getContractFactory("MaliciousAttacker");
    const attacker = await MaliciousAttacker.deploy();
    await attacker.waitForDeployment();

    // Deploy MaliciousReceiver
    const MaliciousReceiver = await ethers.getContractFactory("MaliciousReceiver");
    const maliciousReceiver = await MaliciousReceiver.deploy();
    await maliciousReceiver.waitForDeployment();

    // Get impersonated signers for the contracts
    const attackerAddress = await attacker.getAddress();
    const receiverAddress = await maliciousReceiver.getAddress();
    const attackerSigner = await ethers.getImpersonatedSigner(attackerAddress);
    const receiverSigner = await ethers.getImpersonatedSigner(receiverAddress);

    // Fund the impersonated signers so they can send transactions
    await manager.sendTransaction({
      to: attackerAddress,
      value: ethers.parseEther("1")
    });
    await manager.sendTransaction({
      to: receiverAddress,
      value: ethers.parseEther("1")
    });

    return {
      split,
      manager,
      alice,
      bob,
      charlie,
      attacker,
      maliciousReceiver,
      attackerSigner,
      receiverSigner
    };
  }

  async function setupFundedSplit(split, manager, participants, amount) {
    // Join participants
    for (const participant of participants) {
      await split.connect(participant).join();
    }

    // Fund the split
    await split.connect(manager).fund({ value: amount });

    // Finalize distribution
    await split.connect(manager).finalizeDistribution();
  }

  describe("Reentrancy Attack", function () {
    it("should prevent reentrant withdrawals", async function () {
      const { split, manager, attacker, attackerSigner } = await deployVulnerableSetup();

      // Attacker joins as participant
      await split.connect(attackerSigner).join();

      // Manager funds and finalizes
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      // Verify attacker has claimable balance
      const claimableBefore = await split.claimable(await attacker.getAddress());
      expect(claimableBefore).to.equal(ethers.parseEther("1"));

      // Record contract balance before attack
      const contractBalanceBefore = await split.contractBalance();

      // Launch the attack
      await attacker.attack(await split.getAddress());

      // Check attack results
      const attackCount = await attacker.attackCount();
      const attackSucceeded = await attacker.attackSucceeded();
      const attackerBalance = await attacker.getBalance();

      // Attack should have only succeeded once (the initial withdrawal)
      expect(attackCount).to.equal(1);
      expect(attackSucceeded).to.equal(false);

      // Attacker should have more than their setup ETH (proving withdrawal worked)
      // Setup was 1 ETH, legitimate withdrawal adds ~1 ETH (minus gas)
      expect(attackerBalance).to.be.greaterThan(ethers.parseEther("1"));
      expect(attackerBalance).to.be.lessThan(ethers.parseEther("2"));

      // Contract should have no remaining claimable for attacker
      expect(await split.claimable(await attacker.getAddress())).to.equal(0);

      // Contract balance should be reduced by exactly the legitimate withdrawal
      expect(await split.contractBalance()).to.equal(
        contractBalanceBefore - ethers.parseEther("1")
      );
    });

    it("should prevent reentrancy even with multiple participants", async function () {
      const { split, manager, alice, attacker, attackerSigner } = await deployVulnerableSetup();

      // Both Alice and attacker join
      await split.connect(alice).join();
      await split.connect(attackerSigner).join();

      // Fund with 2 ETH
      await split.connect(manager).fund({ value: ethers.parseEther("2") });
      await split.connect(manager).finalizeDistribution();

      // Each should have 1 ETH claimable
      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("1"));
      expect(await split.claimable(await attacker.getAddress())).to.equal(ethers.parseEther("1"));

      // Launch attack
      await attacker.attack(await split.getAddress());

      // Check attack failed
      expect(await attacker.attackSucceeded()).to.equal(false);

      // Attacker has more than setup ETH (proving legitimate withdrawal worked)
      expect(await attacker.getBalance()).to.be.greaterThan(ethers.parseEther("1"));
      expect(await attacker.getBalance()).to.be.lessThan(ethers.parseEther("2"));

      // Alice still has her 1 ETH claimable (unaffected by attack)
      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("1"));

      // Contract still has Alice's funds
      expect(await split.contractBalance()).to.equal(ethers.parseEther("1"));
    });
  });

  describe("Malicious Receiver Attack", function () {
    it("should handle withdrawal to contract that rejects ETH", async function () {
      const { split, manager, maliciousReceiver, receiverSigner } = await deployVulnerableSetup();

      // Malicious receiver joins
      await split.connect(receiverSigner).join();

      // Fund and finalize
      await split.connect(manager).fund({ value: ethers.parseEther("0.5") });
      await split.connect(manager).finalizeDistribution();

      // Malicious receiver has claimable balance
      expect(await split.claimable(await maliciousReceiver.getAddress())).to.equal(
        ethers.parseEther("0.5")
      );

      // Attempt withdrawal (will fail internally because receive() reverts)
      await maliciousReceiver.joinAndWithdraw(await split.getAddress());

      // The claimable balance should remain unchanged (transaction reverted)
      expect(await split.claimable(await maliciousReceiver.getAddress())).to.equal(
        ethers.parseEther("0.5")
      );

      // Contract still holds the funds
      expect(await split.contractBalance()).to.equal(ethers.parseEther("0.5"));
    });
  });

  describe("Unauthorized Access Tests", function () {
    it("should prevent non-manager from finalizing distribution", async function () {
      const { split, alice, bob } = await deployVulnerableSetup();

      await split.connect(alice).join();
      await split.connect(bob).join();

      // Alice (non-manager) tries to finalize
      await expect(
        split.connect(alice).finalizeDistribution()
      ).to.be.revertedWithCustomError(split, "OnlyManager");
    });

    it("should prevent non-manager from funding", async function () {
      const { split, alice } = await deployVulnerableSetup();

      await expect(
        split.connect(alice).fund({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(split, "OnlyManager");
    });

    it("should prevent manager from joining own split", async function () {
      const { split, manager } = await deployVulnerableSetup();

      await expect(
        split.connect(manager).join()
      ).to.be.revertedWithCustomError(split, "ManagerCannotJoin");
    });
  });

  describe("State Manipulation Tests", function () {
    it("should maintain accounting invariants after multiple operations", async function () {
      const { split, manager, alice, bob } = await deployVulnerableSetup();

      // Round 1
      await setupFundedSplit(
        split,
        manager,
        [alice, bob],
        ethers.parseEther("1")
      );

      const totalClaimableAfterRound1 = await split.totalClaimable();
      expect(totalClaimableAfterRound1).to.equal(ethers.parseEther("1"));

      // Alice withdraws
      await split.connect(alice).withdraw();

      // Accounting should remain consistent
      expect(await split.totalClaimable()).to.equal(ethers.parseEther("0.5"));
      expect(await split.contractBalance()).to.equal(ethers.parseEther("0.5"));

      // Round 2
      await split.connect(alice).join();
      await split.connect(manager).fund({ value: ethers.parseEther("0.4") });
      await split.connect(manager).finalizeDistribution();

      // Total claimable: Bob's 0.5 + Alice's new 0.4 = 0.9
      expect(await split.totalClaimable()).to.equal(ethers.parseEther("0.9"));

      // Contract balance: 0.5 (Bob) + 0.4 (Alice) = 0.9
      expect(await split.contractBalance()).to.equal(ethers.parseEther("0.9"));
    });

    it("should not allow claimable balance to exceed contract balance", async function () {
      const { split, manager, alice, bob, charlie } = await deployVulnerableSetup();

      // Multiple rounds
      await setupFundedSplit(
        split,
        manager,
        [alice, bob],
        ethers.parseEther("1")
      );

      await split.connect(alice).join();
      await split.connect(charlie).join();
      await split.connect(manager).fund({ value: ethers.parseEther("0.6") });
      await split.connect(manager).finalizeDistribution();

      // Verify invariant: totalClaimable + roundPool <= contractBalance
      const totalClaimable = await split.totalClaimable();
      const roundPool = await split.roundPool();
      const contractBalance = await split.contractBalance();

      expect(totalClaimable + roundPool).to.be.lessThanOrEqual(contractBalance);
    });
  });

  describe("Front-running Protection", function () {
    it("should not allow participant list manipulation", async function () {
      const { split, manager, alice, bob } = await deployVulnerableSetup();

      // Alice joins
      await split.connect(alice).join();

      // Bob tries to remove Alice (should fail - no such function)
      const participants = await split.getParticipants();
      expect(participants).to.deep.equal([alice.address]);

      // Bob can join but can't affect Alice's position
      await split.connect(bob).join();
      expect(await split.participantCount()).to.equal(2);
    });

    it("should handle rapid join/finalize race condition safely", async function () {
      const { split, manager, alice, bob } = await deployVulnerableSetup();

      // Alice joins
      await split.connect(alice).join();

      // Fund
      await split.connect(manager).fund({ value: ethers.parseEther("1") });

      // Bob tries to join after funding but before finalization
      await split.connect(bob).join();

      // Finalize - both should be included
      await split.connect(manager).finalizeDistribution();

      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("0.5"));
      expect(await split.claimable(bob.address)).to.equal(ethers.parseEther("0.5"));
    });
  });
});
