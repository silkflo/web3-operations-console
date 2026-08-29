// ethereum-v3/test/unit/EthSplit.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("EthSplit - Unit Tests", function () {
  // Test fixtures
  async function deployEthSplit() {
    const [manager, alice, bob, charlie] = await ethers.getSigners();
    const EthSplit = await ethers.getContractFactory("EthSplit");
    const split = await EthSplit.deploy("Portfolio Split Demo", manager.address);
    await split.waitForDeployment();
    return { split, manager, alice, bob, charlie };
  }

  describe("Deployment", function () {
    it("should deploy with correct initial values", async function () {
      const { split, manager } = await deployEthSplit();

      expect(await split.manager()).to.equal(manager.address);
      expect(await split.title()).to.equal("Portfolio Split Demo");
      expect(await split.round()).to.equal(1);
      expect(await split.participantCount()).to.equal(0);
      expect(await split.roundPool()).to.equal(0);
      expect(await split.totalClaimable()).to.equal(0);
      expect(await split.VERSION()).to.equal("3.0.0");
      expect(await split.MAX_PARTICIPANTS()).to.equal(50);
    });

    it("should reject zero address as manager", async function () {
      const EthSplit = await ethers.getContractFactory("EthSplit");
      await expect(
        EthSplit.deploy("Test", ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(EthSplit, "InvalidAddress");
    });

    it("should reject empty title", async function () {
      const [manager] = await ethers.getSigners();
      const EthSplit = await ethers.getContractFactory("EthSplit");
      await expect(
        EthSplit.deploy("", manager.address)
      ).to.be.revertedWithCustomError(EthSplit, "EmptyTitle");
    });
  });

  describe("Joining", function () {
    it("should allow participants to join", async function () {
      const { split, alice, bob } = await deployEthSplit();

      await split.connect(alice).join();
      await split.connect(bob).join();

      expect(await split.participantCount()).to.equal(2);
      expect(await split.isParticipant(alice.address)).to.equal(true);
      expect(await split.isParticipant(bob.address)).to.equal(true);

      const participants = await split.getParticipants();
      expect(participants).to.deep.equal([alice.address, bob.address]);
    });

    it("should reject manager joining", async function () {
      const { split, manager } = await deployEthSplit();

      await expect(
        split.connect(manager).join()
      ).to.be.revertedWithCustomError(split, "ManagerCannotJoin");
    });

    it("should reject duplicate joins", async function () {
      const { split, alice } = await deployEthSplit();

      await split.connect(alice).join();

      await expect(
        split.connect(alice).join()
      ).to.be.revertedWithCustomError(split, "AlreadyJoined");
    });

    it("should enforce participant limit with available signers", async function () {
      const { split, manager } = await deployEthSplit();
      const signers = await ethers.getSigners();

      // Join all available signers except manager (18 participants)
      const availableParticipants = signers.filter(s => s.address !== manager.address);

      for (const signer of availableParticipants) {
        await split.connect(signer).join();
      }

      expect(await split.participantCount()).to.equal(availableParticipants.length);
    });
  });

  describe("Funding", function () {
    it("should allow manager to fund", async function () {
      const { split, manager } = await deployEthSplit();
      const amount = ethers.parseEther("1");

      await expect(
        split.connect(manager).fund({ value: amount })
      ).to.emit(split, "Funded")
        .withArgs(manager.address, 1, amount, amount);

      expect(await split.roundPool()).to.equal(amount);
      expect(await split.contractBalance()).to.equal(amount);
    });

    it("should allow multiple fundings in same round", async function () {
      const { split, manager } = await deployEthSplit();

      await split.connect(manager).fund({ value: ethers.parseEther("0.5") });
      await split.connect(manager).fund({ value: ethers.parseEther("0.3") });

      expect(await split.roundPool()).to.equal(ethers.parseEther("0.8"));
    });

    it("should reject zero funding", async function () {
      const { split, manager } = await deployEthSplit();

      await expect(
        split.connect(manager).fund({ value: 0 })
      ).to.be.revertedWithCustomError(split, "ZeroFundingAmount");
    });

    it("should reject non-manager funding", async function () {
      const { split, alice } = await deployEthSplit();

      await expect(
        split.connect(alice).fund({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(split, "OnlyManager");
    });
  });

  describe("Distribution", function () {
    it("should distribute equally among participants", async function () {
      const { split, manager, alice, bob } = await deployEthSplit();

      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });

      await expect(
        split.connect(manager).finalizeDistribution()
      ).to.emit(split, "DistributionFinalized")
        .withArgs(1, ethers.parseEther("1"), 2, ethers.parseEther("0.5"), 0);

      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("0.5"));
      expect(await split.claimable(bob.address)).to.equal(ethers.parseEther("0.5"));
      expect(await split.round()).to.equal(2);
      expect(await split.participantCount()).to.equal(0);
    });

    it("should handle remainder correctly", async function () {
      const { split, manager, alice, bob, charlie } = await deployEthSplit();

      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(charlie).join();

      // Fund 1 ETH / 3 participants = 0.333... remainder 1 wei
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      const expectedShare = ethers.parseEther("1") / 3n;
      expect(await split.claimable(alice.address)).to.equal(expectedShare);
      expect(await split.claimable(bob.address)).to.equal(expectedShare);
      expect(await split.claimable(charlie.address)).to.equal(expectedShare);

      // Remainder should be in roundPool for next round
      const remainder = ethers.parseEther("1") - (expectedShare * 3n);
      expect(await split.roundPool()).to.equal(remainder);
    });

    it("should reject distribution with no participants", async function () {
      const { split, manager } = await deployEthSplit();

      await split.connect(manager).fund({ value: ethers.parseEther("1") });

      await expect(
        split.connect(manager).finalizeDistribution()
      ).to.be.revertedWithCustomError(split, "NoParticipants");
    });

    it("should reject distribution with no funding", async function () {
      const { split, manager, alice } = await deployEthSplit();

      await split.connect(alice).join();

      await expect(
        split.connect(manager).finalizeDistribution()
      ).to.be.revertedWithCustomError(split, "NoRoundFunding");
    });

    it("should reject distribution when amount too small", async function () {
      const { split, manager, alice, bob } = await deployEthSplit();

      await split.connect(alice).join();
      await split.connect(bob).join();

      // Fund 1 wei for 2 participants = 0 per person
      await split.connect(manager).fund({ value: 1 });

      await expect(
        split.connect(manager).finalizeDistribution()
      ).to.be.revertedWithCustomError(split, "InsufficientDistributionAmount");
    });
  });

  describe("Withdrawal", function () {
    it("should allow participants to withdraw", async function () {
      const { split, manager, alice, bob } = await deployEthSplit();

      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      await expect(
        split.connect(alice).withdraw()
      ).to.emit(split, "Withdrawal")
        .withArgs(alice.address, ethers.parseEther("0.5"), 0);

      expect(await split.claimable(alice.address)).to.equal(0);
      expect(await split.totalClaimable()).to.equal(ethers.parseEther("0.5"));
    });

    it("should reject withdrawal with no claimable balance", async function () {
      const { split, alice } = await deployEthSplit();

      await expect(
        split.connect(alice).withdraw()
      ).to.be.revertedWithCustomError(split, "NothingToWithdraw");
    });

    it("should prevent double withdrawal", async function () {
      const { split, manager, alice, bob } = await deployEthSplit();

      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      await split.connect(alice).withdraw();

      await expect(
        split.connect(alice).withdraw()
      ).to.be.revertedWithCustomError(split, "NothingToWithdraw");
    });

    it("should support multiple rounds with accumulated claims", async function () {
      const { split, manager, alice, bob } = await deployEthSplit();

      // Round 1
      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("0.5"));

      // Round 2 - Alice rejoins, Bob doesn't
      await split.connect(alice).join();
      await split.connect(manager).fund({ value: ethers.parseEther("0.2") });
      await split.connect(manager).finalizeDistribution();

      // Alice's claim accumulates
      expect(await split.claimable(alice.address)).to.equal(ethers.parseEther("0.7"));
      // Bob's claim stays from round 1
      expect(await split.claimable(bob.address)).to.equal(ethers.parseEther("0.5"));
    });
  });

  describe("View Functions", function () {
    it("should return correct contract info", async function () {
      const { split, manager } = await deployEthSplit();

      const [version, managerAddress, currentRound, currentCount] =
        await split.getContractInfo();

      expect(version).to.equal("3.0.0");
      expect(managerAddress).to.equal(manager.address);
      expect(currentRound).to.equal(1);
      expect(currentCount).to.equal(0);
    });

    it("should return claimable balance for specific address", async function () {
      const { split, manager, alice, bob } = await deployEthSplit();

      await split.connect(alice).join();
      await split.connect(bob).join();
      await split.connect(manager).fund({ value: ethers.parseEther("1") });
      await split.connect(manager).finalizeDistribution();

      expect(await split.getClaimable(alice.address)).to.equal(ethers.parseEther("0.5"));
    });
  });
});
