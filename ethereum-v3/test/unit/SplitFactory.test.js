// ethereum-v3/test/unit/SplitFactory.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SplitFactory - Unit Tests", function () {
  // Test fixtures
  async function deployFactory() {
    const [alice, bob, charlie] = await ethers.getSigners();
    const SplitFactory = await ethers.getContractFactory("SplitFactory");
    const factory = await SplitFactory.deploy();
    await factory.waitForDeployment();
    return { factory, alice, bob, charlie };
  }

  describe("Deployment", function () {
    it("should deploy with correct initial values", async function () {
      const { factory } = await deployFactory();

      expect(await factory.splitCount()).to.equal(0);
      expect(await factory.VERSION()).to.equal("3.0.0");
      expect(await factory.DEFAULT_PAGE_SIZE()).to.equal(20);
      expect(await factory.MAX_PAGE_SIZE()).to.equal(100);
    });
  });

  describe("Split Creation", function () {
    it("should create a split with correct metadata", async function () {
      const { factory, alice } = await deployFactory();

      await expect(
        factory.connect(alice).createSplit("Friday Dinner")
      ).to.emit(factory, "SplitCreated");

      expect(await factory.splitCount()).to.equal(1);

      const [splitAddress, manager, title, blockNumber, timestamp] =
        await factory.getSplitInfo(0);

      expect(manager).to.equal(alice.address);
      expect(title).to.equal("Friday Dinner");
      expect(splitAddress).to.not.equal(ethers.ZeroAddress);
      expect(blockNumber).to.be.greaterThan(0);
      expect(timestamp).to.be.greaterThan(0);

      // Verify factory recognizes the deployment
      expect(await factory.isDeployedByFactory(splitAddress)).to.equal(true);
    });

    it("should create independent splits for different users", async function () {
      const { factory, alice, bob } = await deployFactory();

      await factory.connect(alice).createSplit("Alice's Split");
      await factory.connect(bob).createSplit("Bob's Split");

      expect(await factory.splitCount()).to.equal(2);

      const [aliceSplitAddress] = await factory.getSplitInfo(0);
      const [bobSplitAddress] = await factory.getSplitInfo(1);

      expect(aliceSplitAddress).to.not.equal(bobSplitAddress);

      // Verify manager is set correctly for each
      const aliceSplit = await ethers.getContractAt("EthSplit", aliceSplitAddress);
      const bobSplit = await ethers.getContractAt("EthSplit", bobSplitAddress);

      expect(await aliceSplit.manager()).to.equal(alice.address);
      expect(await bobSplit.manager()).to.equal(bob.address);
    });

    it("should reject empty title", async function () {
      const { factory, alice } = await deployFactory();

      await expect(
        factory.connect(alice).createSplit("")
      ).to.be.revertedWithCustomError(factory, "EmptyTitle");
    });
  });

  describe("Pagination", function () {
    it("should paginate results correctly", async function () {
      const { factory, alice } = await deployFactory();

      // Create 25 splits
      for (let i = 0; i < 25; i++) {
        await factory.connect(alice).createSplit(`Split ${i}`);
      }

      // Get first page (20 items)
      const [firstPage, totalSplits] = await factory.getSplitsPaginated(0, 20);
      expect(firstPage.length).to.equal(20);
      expect(totalSplits).to.equal(25);
      expect(firstPage[0].title).to.equal("Split 0");
      expect(firstPage[19].title).to.equal("Split 19");

      // Get second page (5 items)
      const [secondPage] = await factory.getSplitsPaginated(20, 20);
      expect(secondPage.length).to.equal(5);
      expect(secondPage[0].title).to.equal("Split 20");
      expect(secondPage[4].title).to.equal("Split 24");
    });

    it("should use default page size with getSplits", async function () {
      const { factory, alice } = await deployFactory();

      // Create 15 splits
      for (let i = 0; i < 15; i++) {
        await factory.connect(alice).createSplit(`Split ${i}`);
      }

      const [results, totalSplits] = await factory.getSplits(0);
      expect(results.length).to.equal(15);
      expect(totalSplits).to.equal(15);
    });

    it("should reject offset out of bounds", async function () {
      const { factory } = await deployFactory();

      await expect(
        factory.getSplitsPaginated(1, 20)
      ).to.be.revertedWithCustomError(factory, "InvalidOffset");
    });

    it("should reject page size too large", async function () {
      const { factory } = await deployFactory();

      await expect(
        factory.getSplitsPaginated(0, 101)
      ).to.be.revertedWithCustomError(factory, "PageSizeTooLarge");
    });

    it("should handle empty results when offset equals total", async function () {
      const { factory, alice } = await deployFactory();

      // Create 5 splits
      for (let i = 0; i < 5; i++) {
        await factory.connect(alice).createSplit(`Split ${i}`);
      }

      // Offset 5 = total 5, should return empty array
      const [results, totalSplits] = await factory.getSplitsPaginated(5, 20);
      expect(results.length).to.equal(0);
      expect(totalSplits).to.equal(5);
    });
  });

  describe("Recent Splits", function () {
    it("should return most recent splits", async function () {
      const { factory, alice } = await deployFactory();

      // Create 10 splits
      for (let i = 0; i < 10; i++) {
        await factory.connect(alice).createSplit(`Split ${i}`);
      }

      const recentSplits = await factory.getRecentSplits(3);

      expect(recentSplits.length).to.equal(3);
      expect(recentSplits[0].title).to.equal("Split 7");
      expect(recentSplits[1].title).to.equal("Split 8");
      expect(recentSplits[2].title).to.equal("Split 9");
    });

    it("should return all splits if count exceeds total", async function () {
      const { factory, alice } = await deployFactory();

      // Create 3 splits
      for (let i = 0; i < 3; i++) {
        await factory.connect(alice).createSplit(`Split ${i}`);
      }

      const recentSplits = await factory.getRecentSplits(10);

      expect(recentSplits.length).to.equal(3);
    });

    it("should reject count exceeding max page size", async function () {
      const { factory } = await deployFactory();

      await expect(
        factory.getRecentSplits(101)
      ).to.be.revertedWithCustomError(factory, "PageSizeTooLarge");
    });
  });

  describe("Factory Info", function () {
    it("should return correct factory metadata", async function () {
      const { factory, alice } = await deployFactory();

      await factory.connect(alice).createSplit("Test Split");

      const [version, deployedSplits, defaultPageSize, maxPageSize] =
        await factory.getFactoryInfo();

      expect(version).to.equal("3.0.0");
      expect(deployedSplits).to.equal(1);
      expect(defaultPageSize).to.equal(20);
      expect(maxPageSize).to.equal(100);
    });

    it("should correctly verify factory deployments", async function () {
      const { factory, alice } = await deployFactory();

      // Create a split
      await factory.connect(alice).createSplit("Test");
      const [splitAddress] = await factory.getSplitInfo(0);

      // Factory should recognize its own deployment
      expect(await factory.isDeployedByFactory(splitAddress)).to.equal(true);

      // Random address should not be recognized
      expect(await factory.isDeployedByFactory(alice.address)).to.equal(false);
    });
  });

  describe("Integration with EthSplit", function () {
    it("should create functional splits through factory", async function () {
      const { factory, alice, bob } = await deployFactory();

      // Create split through factory
      await factory.connect(alice).createSplit("Integration Test");
      const [splitAddress] = await factory.getSplitInfo(0);

      // Get the deployed EthSplit contract
      const split = await ethers.getContractAt("EthSplit", splitAddress);

      // Verify it's fully functional
      expect(await split.manager()).to.equal(alice.address);

      // Bob can join
      await split.connect(bob).join();
      expect(await split.participantCount()).to.equal(1);

      // Alice can fund
      await split.connect(alice).fund({ value: ethers.parseEther("0.1") });
      expect(await split.roundPool()).to.equal(ethers.parseEther("0.1"));

      // Alice can finalize
      await split.connect(alice).finalizeDistribution();
      expect(await split.claimable(bob.address)).to.equal(ethers.parseEther("0.1"));

      // Bob can withdraw
      await split.connect(bob).withdraw();
      expect(await split.claimable(bob.address)).to.equal(0);
    });
  });
});
