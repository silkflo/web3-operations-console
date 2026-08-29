// ethereum-v3/test/demo/Workflow.test.js
//
// Guard rails around the deploy/seed/sync workflow:
//   - the deploy and seed scripts refuse a non-Sepolia network;
//   - the seed script cannot create duplicates;
//   - the frontend config resolves from the generated deployment file.

const { expect } = require("chai");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { SCENARIOS } = require("../../scripts/lib/scenarios");
const {
  ENVIRONMENT,
  MANIFEST_SCHEMA_VERSION,
  SEPOLIA_CHAIN_ID,
} = require("../../scripts/lib/manifest");
const { buildPayload, serialize } = require("../../scripts/sync-frontend-config");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

/**
 * Runs a hardhat script in a subprocess and returns { status, output }.
 *
 * Invokes hardhat's own entry point with process.execPath rather than the npx
 * shim: on Windows, Node 24+ refuses to exec a .cmd file without a shell, and
 * going through the shim swallowed the script's output entirely.
 */
const HARDHAT_BIN = require.resolve("hardhat/internal/cli/bootstrap.js");

const runScript = (script, network) => {
  const result = spawnSync(
    process.execPath,
    [HARDHAT_BIN, "run", script, "--network", network],
    { cwd: PROJECT_ROOT, encoding: "utf8" }
  );

  return {
    status: result.status === null ? 1 : result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
};

describe("Demo — network guard", function () {
  // Spawning hardhat is slow; these are the only tests that need a subprocess.
  this.timeout(180000);

  it("deploy-demo refuses to run against the local hardhat chain", function () {
    const { status, output } = runScript("scripts/deploy-demo.js", "hardhat");

    expect(status, "script should exit non-zero").to.not.equal(0);
    expect(output).to.match(/Refusing to deploy/);
    expect(output).to.match(/requires Sepolia/);
  });

  it("seed-demo refuses to run against the local hardhat chain", function () {
    const { status, output } = runScript("scripts/seed-demo.js", "hardhat");

    expect(status, "script should exit non-zero").to.not.equal(0);
    expect(output).to.match(/Refusing to seed/);
    expect(output).to.match(/requires Sepolia/);
  });
});

describe("Demo — seed duplicate protection", function () {
  // The seed script treats the manifest as its ledger: a scenario key that is
  // already recorded is never created again. This mirrors that selection logic.
  const pendingFor = (manifest) => {
    const seeded = new Set(manifest.splits.map((split) => split.key));
    return SCENARIOS.filter((scenario) => !seeded.has(scenario.key));
  };

  it("treats every scenario as pending on an empty manifest", function () {
    expect(pendingFor({ splits: [] })).to.have.lengthOf(SCENARIOS.length);
  });

  it("covers exactly the three demo scenarios", function () {
    expect(SCENARIOS.map((s) => s.key)).to.deep.equal([
      "creator-revenue-share",
      "product-team-bonus",
      "project-partner-settlement",
    ]);
  });

  it("skips scenarios already recorded", function () {
    const manifest = {
      splits: [{ key: "creator-revenue-share" }, { key: "product-team-bonus" }],
    };

    const pending = pendingFor(manifest);

    expect(pending).to.have.lengthOf(1);
    expect(pending.map((s) => s.key)).to.deep.equal([
      "project-partner-settlement",
    ]);
  });

  it("has nothing pending once all are recorded", function () {
    const manifest = { splits: SCENARIOS.map((s) => ({ key: s.key })) };
    expect(pendingFor(manifest)).to.have.lengthOf(0);
  });

  it("stays idempotent when the manifest holds unknown extra keys", function () {
    const manifest = {
      splits: [...SCENARIOS.map((s) => ({ key: s.key })), { key: "legacy" }],
    };
    expect(pendingFor(manifest)).to.have.lengthOf(0);
  });
});

describe("Demo — frontend configuration", function () {
  const seededManifest = () => ({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    environment: ENVIRONMENT,
    chainId: SEPOLIA_CHAIN_ID,
    networkName: "sepolia",
    factoryAddress: "0x5555555555555555555555555555555555555555",
    factoryVersion: "3.0.0",
    deployerAddress: "0x6666666666666666666666666666666666666666",
    deploymentTxHash: `0x${"c".repeat(64)}`,
    deploymentBlockNumber: 999,
    deployedAt: "2026-01-01T00:00:00.000Z",
    explorer: { factory: "https://x", deploymentTx: "https://y" },
    contracts: {
      SplitFactory: { version: "3.0.0" },
      EthSplit: { version: "3.0.0" },
    },
    splits: SCENARIOS.map((scenario, index) => ({
      key: scenario.key,
      title: scenario.title,
      description: scenario.description,
      splitAddress: `0x${String(index + 1).repeat(40)}`,
      creationTxHash: `0x${"d".repeat(64)}`,
      creationBlockNumber: 1000 + index,
      participants: ["0x7777777777777777777777777777777777777777"],
      onChainParticipantCount: scenario.participantCount,
      allocation: { model: "equal", participantCount: scenario.participantCount },
      demoStatus: scenario.fundingEth ? "withdrawn" : "active",
    })),
  });

  it("projects the factory address and version from the manifest", function () {
    const payload = buildPayload(seededManifest());

    expect(payload.factoryAddress).to.equal(
      "0x5555555555555555555555555555555555555555"
    );
    expect(payload.factoryVersion).to.equal("3.0.0");
    expect(payload.chainId).to.equal(SEPOLIA_CHAIN_ID);
    expect(payload.environment).to.equal(ENVIRONMENT);
  });

  it("carries every split through to the frontend", function () {
    const payload = buildPayload(seededManifest());

    expect(payload.splits).to.have.lengthOf(SCENARIOS.length);
    expect(payload.splits.map((s) => s.title)).to.deep.equal(
      SCENARIOS.map((s) => s.title)
    );
  });

  it("never leaks deployer or transaction detail to the browser bundle", function () {
    const payload = buildPayload(seededManifest());

    expect(payload).to.not.have.property("deployerAddress");
    expect(payload).to.not.have.property("deploymentTxHash");
    payload.splits.forEach((split) => {
      expect(split).to.not.have.property("creationTxHash");
      expect(split).to.not.have.property("participants");
      expect(split).to.not.have.property("lifecycle");
    });
  });

  it("produces deterministic output for the --check mode", function () {
    const manifest = seededManifest();
    expect(serialize(buildPayload(manifest))).to.equal(
      serialize(buildPayload(manifest))
    );
  });

  it("ships a committed demo-deployment.json the frontend can read", function () {
    const file = path.join(PROJECT_ROOT, "frontend", "demo-deployment.json");

    expect(fs.existsSync(file), "demo-deployment.json must be committed").to.equal(
      true
    );

    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

    expect(parsed.chainId).to.equal(SEPOLIA_CHAIN_ID);
    expect(parsed.environment).to.equal(ENVIRONMENT);
    expect(parsed.splits).to.be.an("array");
  });

  it("keeps the factory address out of page components", function () {
    // The whole point of the manifest pipeline: no hardcoded addresses in pages.
    const pagesDir = path.join(PROJECT_ROOT, "..", "pages");

    if (!fs.existsSync(pagesDir)) {
      this.skip();
    }

    const offenders = [];

    const walk = (dir) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(full);
          return;
        }

        if (!/\.(js|jsx)$/.test(entry.name)) {
          return;
        }

        const source = fs.readFileSync(full, "utf8");
        // A 20-byte hex literal assigned to something factory-ish.
        const matches = source.match(
          /FACTORY_ADDRESS\s*=\s*["']0x[0-9a-fA-F]{40}["']/g
        );

        if (matches) {
          offenders.push(path.relative(pagesDir, full));
        }
      });
    };

    walk(pagesDir);

    expect(
      offenders,
      `hardcoded factory address in: ${offenders.join(", ")}`
    ).to.deep.equal([]);
  });
});
