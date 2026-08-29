// ethereum-v3/scripts/deploy.js

const { ethers, run, network } = require("hardhat");

/**
 * Deploys SplitFactory to the configured network
 * Handles verification on block explorers
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("==========================================");
  console.log("Deploying SplitFactory V3");
  console.log("==========================================");
  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
  console.log("------------------------------------------");

  // Deploy the factory
  const SplitFactory = await ethers.getContractFactory("SplitFactory");
  console.log("Deploying SplitFactory...");

  const factory = await SplitFactory.deploy();
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  console.log("SplitFactory deployed to:", factoryAddress);
  console.log("------------------------------------------");

  // Wait for block confirmations
  const confirmations = network.name === "hardhat" || network.name === "localhost" ? 1 : 5;
  console.log(`Waiting for ${confirmations} confirmation(s)...`);

  const deployReceipt = await factory.deploymentTransaction().wait(confirmations);
  console.log("Deployment confirmed in block:", deployReceipt.blockNumber);
  console.log("------------------------------------------");

  // Verify on Etherscan if on a public network
  if (network.name === "sepolia") {
    console.log("Verifying contract on Etherscan...");

    try {
      await run("verify:verify", {
        address: factoryAddress,
        constructorArguments: [],
      });
      console.log("Contract verified successfully!");
    } catch (error) {
      console.error("Verification failed:", error.message);
      console.log("You can verify manually with:");
      console.log(`npx hardhat verify --network sepolia ${factoryAddress}`);
    }
  }

  console.log("==========================================");
  console.log("Deployment Summary");
  console.log("==========================================");
  console.log("Factory Address:", factoryAddress);
  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);

  if (network.name === "sepolia") {
    console.log("Etherscan:", `https://sepolia.etherscan.io/address/${factoryAddress}`);
  }

  console.log("==========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
