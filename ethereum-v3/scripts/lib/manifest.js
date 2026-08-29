// ethereum-v3/scripts/lib/manifest.js
//
// Read/write/validate the portfolio-demo deployment manifest.
//
// The manifest is the single source of truth that links the on-chain
// deployment to the frontend. It is committed to git; the frontend config is
// generated from it, so a factory address can never be hand-edited into a page
// component and drift.

const fs = require("fs");
const path = require("path");

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments");
const DEFAULT_MANIFEST = "sepolia-demo-v1.json";
const MANIFEST_SCHEMA_VERSION = 1;
const ENVIRONMENT = "portfolio-demo";
const SEPOLIA_CHAIN_ID = 11155111;

const manifestPath = (fileName = DEFAULT_MANIFEST) =>
  path.join(DEPLOYMENTS_DIR, fileName);

const manifestExists = (fileName = DEFAULT_MANIFEST) =>
  fs.existsSync(manifestPath(fileName));

const readManifest = (fileName = DEFAULT_MANIFEST) => {
  const file = manifestPath(fileName);

  if (!fs.existsSync(file)) {
    throw new Error(
      `Deployment manifest not found: ${file}\nRun "npm run deploy:demo:sepolia" first.`
    );
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
};

const writeManifest = (manifest, fileName = DEFAULT_MANIFEST) => {
  validateManifest(manifest);

  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }

  fs.writeFileSync(
    manifestPath(fileName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  return manifestPath(fileName);
};

/**
 * Archives an existing manifest instead of overwriting it.
 *
 * A deployment record describes immutable on-chain history, so it is never
 * destroyed — a redeploy moves the old file aside with a timestamp suffix.
 *
 * @returns {string|null} Path of the archived file, or null if there was none.
 */
const archiveManifest = (fileName = DEFAULT_MANIFEST) => {
  if (!manifestExists(fileName)) {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parsed = path.parse(fileName);
  const archived = `${parsed.name}.superseded-${stamp}${parsed.ext}`;

  fs.renameSync(manifestPath(fileName), manifestPath(archived));

  return manifestPath(archived);
};

const isHexAddress = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

const isTxHash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

/**
 * Validates a manifest against the expected schema.
 * Throws with every problem found, rather than only the first.
 */
const validateManifest = (manifest) => {
  const errors = [];

  const require_ = (condition, message) => {
    if (!condition) {
      errors.push(message);
    }
  };

  require_(
    manifest && typeof manifest === "object",
    "manifest must be an object"
  );

  if (errors.length > 0) {
    throw new Error(`Invalid manifest:\n - ${errors.join("\n - ")}`);
  }

  require_(
    manifest.schemaVersion === MANIFEST_SCHEMA_VERSION,
    `schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`
  );
  require_(
    manifest.environment === ENVIRONMENT,
    `environment must be "${ENVIRONMENT}"`
  );
  require_(
    manifest.chainId === SEPOLIA_CHAIN_ID,
    `chainId must be ${SEPOLIA_CHAIN_ID} (Sepolia)`
  );
  require_(
    manifest.networkName === "sepolia",
    'networkName must be "sepolia"'
  );
  require_(
    isHexAddress(manifest.factoryAddress),
    "factoryAddress must be a 0x-prefixed 20-byte address"
  );
  require_(
    typeof manifest.factoryVersion === "string" &&
      manifest.factoryVersion.length > 0,
    "factoryVersion must be a non-empty string"
  );
  require_(
    isHexAddress(manifest.deployerAddress),
    "deployerAddress must be a 0x-prefixed 20-byte address"
  );
  require_(
    isTxHash(manifest.deploymentTxHash),
    "deploymentTxHash must be a 0x-prefixed 32-byte hash"
  );
  require_(
    Number.isInteger(manifest.deploymentBlockNumber) &&
      manifest.deploymentBlockNumber > 0,
    "deploymentBlockNumber must be a positive integer"
  );
  require_(
    typeof manifest.deployedAt === "string" &&
      !Number.isNaN(Date.parse(manifest.deployedAt)),
    "deployedAt must be an ISO-8601 timestamp"
  );
  require_(
    manifest.contracts && typeof manifest.contracts === "object",
    "contracts must be an object"
  );
  require_(
    Array.isArray(manifest.splits),
    "splits must be an array"
  );

  if (manifest.contracts && typeof manifest.contracts === "object") {
    ["SplitFactory", "EthSplit"].forEach((name) => {
      const entry = manifest.contracts[name];
      require_(
        entry && typeof entry.version === "string",
        `contracts.${name}.version must be a string`
      );
    });
  }

  if (Array.isArray(manifest.splits)) {
    manifest.splits.forEach((split, index) => {
      const at = `splits[${index}]`;

      require_(
        typeof split.key === "string" && split.key.length > 0,
        `${at}.key must be a non-empty string`
      );
      require_(
        typeof split.title === "string" && split.title.length > 0,
        `${at}.title must be a non-empty string`
      );
      require_(
        typeof split.description === "string" && split.description.length > 0,
        `${at}.description must be a non-empty string`
      );
      require_(
        isHexAddress(split.splitAddress),
        `${at}.splitAddress must be a 0x-prefixed 20-byte address`
      );
      require_(
        isTxHash(split.creationTxHash),
        `${at}.creationTxHash must be a 0x-prefixed 32-byte hash`
      );
      require_(
        Number.isInteger(split.creationBlockNumber) &&
          split.creationBlockNumber > 0,
        `${at}.creationBlockNumber must be a positive integer`
      );
      require_(
        Array.isArray(split.participants) && split.participants.length > 0,
        `${at}.participants must be a non-empty array`
      );
      // Recorded from a live contract read after seeding, never inferred from
      // the participants array. EthSplit resets participantCount to 0 on
      // finalizeDistribution(), so a finalized split legitimately reports 0 here
      // while still listing the addresses that joined.
      require_(
        Number.isInteger(split.onChainParticipantCount) &&
          split.onChainParticipantCount >= 0,
        `${at}.onChainParticipantCount must be a non-negative integer read from the contract`
      );
      require_(
        ["created", "active", "funded", "withdrawn"].includes(split.demoStatus),
        `${at}.demoStatus must be one of created|active|funded|withdrawn`
      );
      require_(
        split.allocation && split.allocation.model === "equal",
        `${at}.allocation.model must be "equal" (EthSplit V3 has no weighted distribution)`
      );

      if (Array.isArray(split.participants)) {
        split.participants.forEach((participant, i) => {
          require_(
            isHexAddress(participant),
            `${at}.participants[${i}] must be a 0x-prefixed 20-byte address`
          );
        });
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(`Invalid manifest:\n - ${errors.join("\n - ")}`);
  }

  return true;
};

module.exports = {
  DEPLOYMENTS_DIR,
  DEFAULT_MANIFEST,
  MANIFEST_SCHEMA_VERSION,
  ENVIRONMENT,
  SEPOLIA_CHAIN_ID,
  manifestPath,
  manifestExists,
  readManifest,
  writeManifest,
  archiveManifest,
  validateManifest,
};
