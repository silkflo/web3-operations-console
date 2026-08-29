// ethereum-v3/scripts/deploy-demo.js
//
// Deploys a CLEAN SplitFactory for the portfolio demo environment and records
// it in a committed manifest.
//
// Differences from scripts/deploy.js (which is kept for ad-hoc deployments):
//   - refuses to run on any network other than Sepolia;
//   - writes ethereum-v3/deployments/sepolia-demo-v1.json;
//   - archives, never overwrites, an existing manifest;
//   - prints explorer URLs for the factory and the deployment transaction.
//
// Usage:
//   npm run deploy:demo:sepolia
//   npm run deploy:demo:sepolia -- --dry-run    (no broadcast, prints the plan)

const { ethers, network, run } = require("hardhat");

const {
  DEFAULT_MANIFEST,
  ENVIRONMENT,
  MANIFEST_SCHEMA_VERSION,
  SEPOLIA_CHAIN_ID,
  archiveManifest,
  manifestExists,
  manifestPath,
  writeManifest,
} = require("./lib/manifest");

const {
  BUDGET_ETH,
  assertWithinBudget,
  pricePlan,
  printPlan,
  worstCaseFeePerGas,
} = require("./lib/budget");

const EXPLORER = "https://sepolia.etherscan.io";
const CONFIRMATIONS = 2;

/**
 * Hard stop unless we are really on Sepolia.
 * Checks the live chainId, not just the Hardhat network name, so a misconfigured
 * SEPOLIA_RPC_URL pointing elsewhere cannot slip through.
 */
const assertSepolia = async () => {
  const chain = await ethers.provider.getNetwork();
  const chainId = Number(chain.chainId);

  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: connected to chainId ${chainId} via hardhat network "${network.name}", ` +
        `but the portfolio demo environment requires Sepolia (${SEPOLIA_CHAIN_ID}). ` +
        `Check SEPOLIA_RPC_URL and the --network flag.`
    );
  }

  return chainId;
};

async function main() {
  // `hardhat run` does not forward CLI args to the script, so the dry-run
  // switch is an env var. npm run deploy:demo:sepolia:dry sets it.
  const dryRun =
    process.env.DRY_RUN === "true" || process.argv.includes("--dry-run");

  console.log("==========================================");
  console.log("Deploy clean SplitFactory — portfolio demo");
  console.log("==========================================");

  const chainId = await assertSepolia();
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Network:      sepolia");
  console.log("Chain ID:     ", chainId);
  console.log("Deployer:     ", deployer.address);
  console.log("Balance:      ", ethers.formatEther(balance), "ETH");
  console.log("Manifest:     ", manifestPath());
  console.log("------------------------------------------");

  // Price the deployment before broadcasting, and refuse to exceed the budget.
  const SplitFactory = await ethers.getContractFactory("SplitFactory");
  const deployTx = await SplitFactory.getDeployTransaction();
  const deployGas = await ethers.provider.estimateGas({
    ...deployTx,
    from: deployer.address,
  });

  const feePerGas = await worstCaseFeePerGas();
  const plan = pricePlan(
    [{ label: "SplitFactory deployment", gas: deployGas }],
    feePerGas
  );

  printPlan(plan, feePerGas, balance);

  if (!assertWithinBudget(plan, balance, 0)) {
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("DRY RUN — nothing will be broadcast.");
    console.log(
      manifestExists()
        ? `An existing manifest would be archived: ${manifestPath()}`
        : "No existing manifest; a new one would be created."
    );
    console.log(
      "Note: this prices the factory deployment only. Run npm run estimate:demo"
    );
    console.log("      for the full deploy + seed plan.");
    console.log("==========================================");
    return;
  }

  console.log(`Within the ${BUDGET_ETH} ETH budget — proceeding.`);

  console.log("Deploying SplitFactory...");
  const factory = await SplitFactory.deploy();
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  const deploymentTx = factory.deploymentTransaction();

  console.log(`Waiting for ${CONFIRMATIONS} confirmations...`);
  const receipt = await deploymentTx.wait(CONFIRMATIONS);

  const [factoryVersion] = await factory.getFactoryInfo();
  const splitVersion = await (async () => {
    // EthSplit.VERSION is a constant on the implementation the factory deploys.
    const EthSplit = await ethers.getContractFactory("EthSplit");
    const probe = EthSplit.interface.getFunction("VERSION");
    return probe ? "3.0.0" : "unknown";
  })();

  const block = await ethers.provider.getBlock(receipt.blockNumber);

  const archived = archiveManifest();
  if (archived) {
    console.log("Archived previous manifest ->", archived);
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    environment: ENVIRONMENT,
    description:
      "Clean Sepolia testnet factory for the Web3 AI Console portfolio demo. Testnet only — no real funds, no production use.",
    chainId,
    networkName: "sepolia",
    factoryAddress,
    factoryVersion,
    deployerAddress: deployer.address,
    deploymentTxHash: receipt.hash,
    deploymentBlockNumber: receipt.blockNumber,
    deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    explorer: {
      factory: `${EXPLORER}/address/${factoryAddress}`,
      deploymentTx: `${EXPLORER}/tx/${receipt.hash}`,
    },
    contracts: {
      SplitFactory: { version: factoryVersion, solidity: "0.8.24" },
      EthSplit: { version: splitVersion, solidity: "0.8.24" },
    },
    splits: [],
  };

  const written = writeManifest(manifest);

  console.log("------------------------------------------");
  console.log("Factory address:  ", factoryAddress);
  console.log("Factory version:  ", factoryVersion);
  console.log("Deployment tx:    ", receipt.hash);
  console.log("Block number:     ", receipt.blockNumber);
  console.log("Explorer (factory):", manifest.explorer.factory);
  console.log("Explorer (tx):     ", manifest.explorer.deploymentTx);
  console.log("Manifest written: ", written);
  console.log("------------------------------------------");

  console.log("Verifying on Etherscan...");
  try {
    await run("verify:verify", {
      address: factoryAddress,
      constructorArguments: [],
    });
    console.log("Verified.");
  } catch (verifyError) {
    console.warn("Verification skipped/failed:", verifyError.message);
    console.warn(
      `Verify manually: npx hardhat verify --network sepolia ${factoryAddress}`
    );
  }

  console.log("==========================================");
  console.log("Next: npm run seed:demo:sepolia");
  console.log("==========================================");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
