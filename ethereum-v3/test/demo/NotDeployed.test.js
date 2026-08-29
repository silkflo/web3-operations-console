// ethereum-v3/test/demo/NotDeployed.test.js
//
// Two guards:
//   1. the generated frontend config honestly reflects deployment state, and
//      the page still handles the not-deployed case correctly (that code path
//      must keep working even now that a factory exists — a future redeploy or
//      a fresh clone lands back in it);
//   2. participant addresses never reach the browser bundle.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const { buildPayload } = require("../../scripts/sync-frontend-config");
const {
  ENVIRONMENT,
  MANIFEST_SCHEMA_VERSION,
  SEPOLIA_CHAIN_ID,
} = require("../../scripts/lib/manifest");
const { SCENARIOS } = require("../../scripts/lib/scenarios");
// Fixed addresses standing in for participants in the payload-shape tests.
// Real seeded participants are derived from DEMO_MNEMONIC, never hardcoded.
const SAMPLE_PARTICIPANTS = [
  "0x1010101010101010101010101010101010101010",
  "0x2020202020202020202020202020202020202020",
  "0x3030303030303030303030303030303030303030",
  "0x4040404040404040404040404040404040404040",
];

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const FRONTEND_CONFIG = path.join(PROJECT_ROOT, "frontend", "config.js");
const DEMO_DEPLOYMENT = path.join(
  PROJECT_ROOT,
  "frontend",
  "demo-deployment.json"
);
const PAGE = path.join(PROJECT_ROOT, "..", "pages", "index.js");

const EXACT_LABEL = "Scenario design participants — not joined on-chain.";

const readDeployment = () =>
  JSON.parse(fs.readFileSync(DEMO_DEPLOYMENT, "utf8"));

describe("Demo — deployment state reporting", function () {
  it("reports a coherent status, whichever state it is in", function () {
    const deployment = readDeployment();

    expect(deployment.status).to.be.oneOf(["deployed", "not-deployed"]);

    if (deployment.status === "deployed") {
      expect(deployment.factoryAddress).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(deployment.factoryVersion).to.equal("3.0.0");
      expect(deployment.splits).to.have.lengthOf(SCENARIOS.length);
    } else {
      expect(deployment.factoryAddress).to.equal(null);
      expect(deployment.splits).to.deep.equal([]);
    }
  });

  it("always carries an explanatory status note", function () {
    const deployment = readDeployment();

    expect(deployment.statusNote).to.be.a("string").and.not.be.empty;

    if (deployment.status === "not-deployed") {
      expect(deployment.statusNote).to.match(/DEMO_FUNDING_PLAN\.md/);
    }
  });

  it("generates a not-deployed payload from an empty manifest", function () {
    // The undeployed branch must keep working: a fresh clone or a redeploy
    // lands back in it.
    const payload = buildPayload({
      environment: ENVIRONMENT,
      chainId: SEPOLIA_CHAIN_ID,
      networkName: "sepolia",
      factoryAddress: null,
      factoryVersion: null,
      deployedAt: null,
      deploymentBlockNumber: null,
      explorer: null,
      splits: [],
    });

    expect(payload.status).to.equal("not-deployed");
    expect(payload.statusNote).to.match(/DEMO_FUNDING_PLAN\.md/);
    expect(payload.splits).to.deep.equal([]);
  });

  it("ships the funding plan document", function () {
    const plan = path.join(PROJECT_ROOT, "DEMO_FUNDING_PLAN.md");

    expect(fs.existsSync(plan), "DEMO_FUNDING_PLAN.md must exist").to.equal(true);

    const text = fs.readFileSync(plan, "utf8");

    // The six required elements of the minimum proper deployment.
    expect(text).to.match(/clean factory/i);
    expect(text).to.match(/three equal-split scenarios/i);
    expect(text).to.match(/real participant joins/i);
    expect(text).to.match(/funded and finalized/i);
    expect(text).to.match(/one withdrawal/i);
    expect(text).to.match(/sepolia testnet/i);
  });

  it("derives IS_DEMO_DEPLOYED from status, not just a non-null address", function () {
    const source = fs.readFileSync(FRONTEND_CONFIG, "utf8");

    expect(source).to.match(/DEMO_STATUS === "deployed"/);
  });

  it("gives the page a distinct unconfigured status, not an error", function () {
    // Milestone 3 renamed this state: the contracts ARE deployed, so the thing
    // that can be missing is the API URL, not the factory.
    const source = fs.readFileSync(PAGE, "utf8");

    expect(source).to.match(/setNetworkStatus\("not-configured"\)/);
    expect(source).to.match(/Web3 API not configured/);
    expect(source).to.match(/NEXT_PUBLIC_WEB3_API_URL/);
  });
});

describe("Demo — participant addresses never reach the browser", function () {
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
      participants: SAMPLE_PARTICIPANTS.slice(0, scenario.participantCount),
      onChainParticipantCount: scenario.participantCount,
      allocation: { model: "equal", participantCount: scenario.participantCount },
      demoStatus: scenario.fundingEth ? "withdrawn" : "active",
    })),
  });

  it("never puts participant addresses into the browser payload", function () {
    // The dashboard reads counts live from the contract; a static address list
    // in the bundle would only invite a stale render.
    const payload = buildPayload(seededManifest());
    const serialized = JSON.stringify(payload);

    payload.splits.forEach((split) => {
      expect(split).to.not.have.property("participants");
      expect(split).to.not.have.property("illustrativeParticipants");
    });

    SAMPLE_PARTICIPANTS.forEach((address) => {
      expect(
        serialized,
        `${address} must not reach the browser bundle`
      ).to.not.include(address);
    });
  });

  it("carries no participant data of any kind", function () {
    // Counts used to be snapshotted here. Milestone 2 reads them live instead,
    // so neither addresses nor stale counts belong in the payload.
    const payload = buildPayload(seededManifest());

    payload.splits.forEach((split) => {
      expect(split).to.not.have.property("participants");
      expect(split).to.not.have.property("illustrativeParticipants");
      expect(split).to.not.have.property("onChainParticipantCount");
      expect(split).to.not.have.property("lifecycleSummary");
    });
  });

  it("marks a seeded payload as deployed and an empty one as not", function () {
    expect(buildPayload(seededManifest()).status).to.equal("deployed");

    const undeployed = { ...seededManifest(), factoryAddress: null, splits: [] };
    expect(buildPayload(undeployed).status).to.equal("not-deployed");
  });

  it("defines the exact required label, once, in the shared config", function () {
    const source = fs.readFileSync(FRONTEND_CONFIG, "utf8");

    expect(source).to.include(EXACT_LABEL);
    expect(source).to.match(/SCENARIO_PARTICIPANTS_LABEL/);
  });

  it("does not let the page read a manifest participant list at all", function () {
    const source = fs.readFileSync(PAGE, "utf8");

    expect(source).to.not.match(/illustrativeParticipants/);
    expect(source).to.not.match(/\.participants/);
  });

  it("renders participant counts supplied by the read API, never the manifest", function () {
    const page = fs.readFileSync(PAGE, "utf8");

    expect(page).to.match(/split\.currentParticipantCount/);
    expect(page).to.not.match(/illustrativeParticipants/);
    expect(page).to.not.match(/DEMO_DEPLOYMENT/);
  });

  it("has no AI evidence surface at all", function () {
    // Stronger than the previous guarantee: rather than suppressing fabricated
    // evidence while undeployed, the page no longer has an analysis surface to
    // fabricate it with. See ConsoleUI.test.js for the placeholder's contract.
    const source = fs.readFileSync(PAGE, "utf8");

    expect(source).to.not.match(/aiResponse|aiEvidence|Evidence:/);
    expect(source).to.not.match(/<textarea/i);
    expect(source).to.include("Contract Intelligence");
  });
});
