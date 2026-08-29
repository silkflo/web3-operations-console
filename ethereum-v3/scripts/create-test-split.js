// ethereum-v3/scripts/create-test-split.js

const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("==========================================");
  console.log("Creating Test Split on V3 Factory");
  console.log("==========================================");
  console.log("Network:", network.name);
  console.log("Creator:", deployer.address);

  const FACTORY_ADDRESS = "0xe8c19124799bd4C2114966689F606a254D683D5d";

  const SplitFactory = await ethers.getContractFactory("SplitFactory");
  const factory = SplitFactory.attach(FACTORY_ADDRESS);

  const title = "V3 Demo Split";
  console.log(`Creating split: "${title}"...`);

  const tx = await factory.createSplit(title);
  const receipt = await tx.wait();

  console.log("Transaction confirmed in block:", receipt.blockNumber);

  const event = receipt.logs
    .map(log => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(parsed => parsed && parsed.name === "SplitCreated");

  if (event) {
    const splitAddress = event.args.splitAddress;
    console.log("New split created at:", splitAddress);
    console.log("Split index:", event.args.index.toString());
    console.log("Etherscan:", `https://sepolia.etherscan.io/address/${splitAddress}`);
  }

  const [version, deployedSplits, defaultPageSize, maxPageSize] = await factory.getFactoryInfo();
  console.log("\nFactory Info:");
  console.log("Version:", version);
  console.log("Total splits:", deployedSplits.toString());
  console.log("Default page size:", defaultPageSize.toString());
  console.log("Max page size:", maxPageSize.toString());

  console.log("==========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
