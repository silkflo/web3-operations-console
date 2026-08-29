// ethereum-v3/scripts/sync-frontend-config.js
//
// Projects the committed deployment manifest into
// ethereum-v3/frontend/demo-deployment.json.
//
// This is what keeps the factory address out of page components: the manifest
// is the source of truth, this script derives the subset the browser needs, and
// frontend/config.js reads only from that generated file.
//
// JSON rather than a JS module so the same artifact can be imported by the
// Next.js bundle and required by the CommonJS test suite.
//
// Usage:
//   npm run sync:frontend
//   npm run sync:frontend -- --check   (verify in sync; non-zero exit if not)

const fs = require("fs");
const path = require("path");

const {
  readManifest,
  manifestPath,
  validateManifest,
} = require("./lib/manifest");

const OUTPUT_FILE = path.join(
  __dirname,
  "..",
  "frontend",
  "demo-deployment.json"
);

/**
 * The subset of the manifest the browser is allowed to see.
 *
 * Participant ADDRESSES are deliberately excluded even though they are now real
 * on-chain participants. The dashboard reads participant counts and balances
 * live from the contract, which is the only source that stays correct as state
 * changes; shipping a static address list would invite a surface to render a
 * stale count. Deployer address and transaction hashes are excluded for the
 * same least-privilege reason. Tests assert this.
 */
const buildPayload = (manifest) => ({
  _generated:
    "GENERATED FILE - do not edit by hand. Source: deployments/" +
    path.basename(manifestPath()) +
    ". Regenerate with: npm run sync:frontend",
  status: manifest.factoryAddress ? "deployed" : "not-deployed",
  statusNote: manifest.factoryAddress
    ? "Live Sepolia testnet demo environment."
    : "No portfolio-demo factory has been deployed. See ethereum-v3/DEMO_FUNDING_PLAN.md.",
  environment: manifest.environment,
  chainId: manifest.chainId,
  networkName: manifest.networkName,
  factoryAddress: manifest.factoryAddress,
  factoryVersion: manifest.factoryVersion,
  deployedAt: manifest.deployedAt,
  deploymentBlockNumber: manifest.deploymentBlockNumber,
  explorer: manifest.explorer,
  splits: manifest.splits.map((split) => ({
    key: split.key,
    title: split.title,
    description: split.description,
    splitAddress: split.splitAddress,
    allocation: split.allocation,
    // NOTE: no lifecycleSummary and no participant-count snapshot. Milestone 2 reconstructs joins, funding,
    // finalization and withdrawals from decoded on-chain event logs, so the
    // manifest is no longer a source of lifecycle facts. It supplies the static
    // scenario description and nothing else.
  })),
});

const serialize = (payload) => `${JSON.stringify(payload, null, 2)}\n`;

function main() {
  const checkOnly = process.argv.includes("--check");
  const manifest = readManifest();

  validateManifest(manifest);

  const source = serialize(buildPayload(manifest));

  if (checkOnly) {
    if (!fs.existsSync(OUTPUT_FILE)) {
      console.error("Frontend config is missing:", OUTPUT_FILE);
      console.error('Run "npm run sync:frontend".');
      process.exitCode = 1;
      return;
    }

    if (fs.readFileSync(OUTPUT_FILE, "utf8") !== source) {
      console.error("Frontend config is out of sync with the manifest.");
      console.error('Run "npm run sync:frontend".');
      process.exitCode = 1;
      return;
    }

    console.log("Frontend config is in sync with", manifestPath());
    return;
  }

  fs.writeFileSync(OUTPUT_FILE, source, "utf8");

  console.log("Wrote", OUTPUT_FILE);
  console.log("  factory:", manifest.factoryAddress);
  console.log("  version:", manifest.factoryVersion);
  console.log("  splits: ", manifest.splits.length);
}

// Only run when invoked directly, so the test suite can require the helpers.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { buildPayload, serialize, OUTPUT_FILE };
