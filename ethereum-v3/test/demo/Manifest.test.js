// ethereum-v3/test/demo/Manifest.test.js
//
// Schema validation for the portfolio-demo deployment manifest.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const {
  DEFAULT_MANIFEST,
  ENVIRONMENT,
  MANIFEST_SCHEMA_VERSION,
  SEPOLIA_CHAIN_ID,
  manifestExists,
  manifestPath,
  readManifest,
  validateManifest,
} = require("../../scripts/lib/manifest");

const { SCENARIOS } = require("../../scripts/lib/scenarios");

/** A minimal manifest that must validate. */
const validManifest = () => ({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  environment: ENVIRONMENT,
  description: "test",
  chainId: SEPOLIA_CHAIN_ID,
  networkName: "sepolia",
  factoryAddress: "0x1111111111111111111111111111111111111111",
  factoryVersion: "3.0.0",
  deployerAddress: "0x2222222222222222222222222222222222222222",
  deploymentTxHash: `0x${"a".repeat(64)}`,
  deploymentBlockNumber: 1234,
  deployedAt: "2026-01-01T00:00:00.000Z",
  explorer: { factory: "https://example", deploymentTx: "https://example" },
  contracts: {
    SplitFactory: { version: "3.0.0", solidity: "0.8.24" },
    EthSplit: { version: "3.0.0", solidity: "0.8.24" },
  },
  splits: [],
});

const validSplit = () => ({
  key: "creator-revenue-share",
  title: "Creator Revenue Share",
  description: "desc",
  splitAddress: "0x3333333333333333333333333333333333333333",
  manager: "0x2222222222222222222222222222222222222222",
  creationTxHash: `0x${"b".repeat(64)}`,
  creationBlockNumber: 1235,
  participants: ["0x4444444444444444444444444444444444444444"],
  onChainParticipantCount: 1,
  allocation: { model: "equal", participantCount: 1, perParticipantShare: "100.00%" },
  demoStatus: "created",
});

describe("Demo — deployment manifest schema", function () {
  it("accepts a well-formed manifest", function () {
    expect(() => validateManifest(validManifest())).to.not.throw();
  });

  it("accepts a manifest carrying split records", function () {
    const manifest = validManifest();
    manifest.splits.push(validSplit());
    expect(() => validateManifest(manifest)).to.not.throw();
  });

  it("rejects a non-Sepolia chainId", function () {
    const manifest = validManifest();
    manifest.chainId = 1;
    expect(() => validateManifest(manifest)).to.throw(/chainId must be 11155111/);
  });

  it("rejects a wrong environment tag", function () {
    const manifest = validManifest();
    manifest.environment = "production";
    expect(() => validateManifest(manifest)).to.throw(/environment must be/);
  });

  it("rejects a malformed factory address", function () {
    const manifest = validManifest();
    manifest.factoryAddress = "0xnope";
    expect(() => validateManifest(manifest)).to.throw(/factoryAddress/);
  });

  it("rejects a malformed deployment transaction hash", function () {
    const manifest = validManifest();
    manifest.deploymentTxHash = "0x1234";
    expect(() => validateManifest(manifest)).to.throw(/deploymentTxHash/);
  });

  it("rejects an unknown demoStatus", function () {
    const manifest = validManifest();
    manifest.splits.push({ ...validSplit(), demoStatus: "cancelled" });
    expect(() => validateManifest(manifest)).to.throw(/demoStatus/);
  });

  it("accepts every real lifecycle status", function () {
    ["created", "active", "funded", "withdrawn"].forEach((demoStatus) => {
      const manifest = validManifest();
      manifest.splits.push({ ...validSplit(), demoStatus });
      expect(() => validateManifest(manifest), demoStatus).to.not.throw();
    });
  });

  it("accepts a finalized split reporting zero current participants", function () {
    // finalizeDistribution() clears participantsList and resets the count, so a
    // withdrawn split legitimately reports 0 while still listing who joined.
    const manifest = validManifest();
    manifest.splits.push({
      ...validSplit(),
      demoStatus: "withdrawn",
      onChainParticipantCount: 0,
    });
    expect(() => validateManifest(manifest)).to.not.throw();
  });

  it("rejects a negative or non-integer participant count", function () {
    const manifest = validManifest();
    manifest.splits.push({ ...validSplit(), onChainParticipantCount: -1 });
    expect(() => validateManifest(manifest)).to.throw(
      /onChainParticipantCount/
    );
  });

  it("rejects a split claiming a weighted allocation model", function () {
    // EthSplit V3 distributes equally; a weighted claim would misrepresent it.
    const manifest = validManifest();
    manifest.splits.push({
      ...validSplit(),
      allocation: { model: "weighted", participantCount: 1 },
    });
    expect(() => validateManifest(manifest)).to.throw(/allocation\.model/);
  });

  it("rejects a split with a malformed participant address", function () {
    const manifest = validManifest();
    manifest.splits.push({ ...validSplit(), participants: ["0xdead"] });
    expect(() => validateManifest(manifest)).to.throw(/participants\[0\]/);
  });

  it("reports every problem at once, not just the first", function () {
    const manifest = validManifest();
    manifest.chainId = 1;
    manifest.environment = "production";

    try {
      validateManifest(manifest);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error.message).to.match(/chainId/);
      expect(error.message).to.match(/environment/);
    }
  });

  describe("committed manifest (skipped until deployed)", function () {
    it("validates and matches the expected scenarios", function () {
      if (!manifestExists()) {
        this.skip();
      }

      const manifest = readManifest();
      expect(() => validateManifest(manifest)).to.not.throw();

      // Once seeding has run, the manifest must describe exactly the
      // configured scenarios, by title, in order.
      if (manifest.splits.length > 0) {
        expect(manifest.splits).to.have.lengthOf(SCENARIOS.length);
        expect(manifest.splits.map((s) => s.title)).to.deep.equal(
          SCENARIOS.map((s) => s.title)
        );
      }
    });
  });

  describe("deployments directory", function () {
    it("never loses a previous deployment record", function () {
      // Superseded manifests are archived alongside, never deleted.
      const dir = path.dirname(manifestPath(DEFAULT_MANIFEST));

      if (!fs.existsSync(dir)) {
        this.skip();
      }

      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      const superseded = files.filter((f) => f.includes(".superseded-"));

      superseded.forEach((file) => {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        expect(parsed.factoryAddress, `${file} must retain its address`).to.be.a(
          "string"
        );
      });
    });
  });
});
