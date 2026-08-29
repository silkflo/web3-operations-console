// ethereum-v3/test/demo/Intelligence.test.js
//
// Tests for the Contract Intelligence pipeline.
//
// These import the REAL modules from lib/contract-intelligence rather than
// mirroring them, so a behaviour change fails here rather than drifting quietly.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const LIB = path.join(__dirname, "..", "..", "..", "lib", "contract-intelligence");

const { buildSplitSnapshot, buildFactorySnapshot, LIFECYCLE } = require(
  path.join(LIB, "model")
);
const { analyze, describeLifecycle } = require(path.join(LIB, "analysis"));
const { QUESTIONS } = require(path.join(LIB, "constants"));
const { formatEth, abbreviateHash, abbreviateAddress } = require(
  path.join(LIB, "format")
);
const { createSnapshotCache, normalizeLog, loadFactorySnapshot } = require(
  path.join(LIB, "loader")
);

const fixtures = require("./fixtures/events");

const PAGE = path.join(__dirname, "..", "..", "..", "pages", "index.js");
const GENERATED_CONFIG = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "demo-deployment.json"
);

const snapshotOf = (fixture, overrides = {}) =>
  buildSplitSnapshot({
    reads: fixture.reads,
    events: fixture.events,
    creation: fixture.creation,
    atBlock: 11585975,
    ...overrides,
  });

const factoryOf = (splits) =>
  buildFactorySnapshot({
    address: fixtures.FACTORY,
    version: "3.0.0",
    deployedSplitCount: splits.length,
    deploymentBlock: 11585248,
    generatedAtBlock: 11585975,
    splits,
  });

/** Serializes anything (BigInt included) so it can be scanned for addresses. */
const dump = (value) =>
  JSON.stringify(value, (key, inner) =>
    typeof inner === "bigint" ? inner.toString() : inner
  );

describe("Intelligence — event ABI decoding", function () {
  it("decodes every V3 event name the pipeline relies on", async function () {
    const factoryAbi = require("../../frontend/SplitFactory.abi.json");
    const splitAbi = require("../../frontend/EthSplit.abi.json");

    const factoryEvents = factoryAbi
      .filter((entry) => entry.type === "event")
      .map((entry) => entry.name);
    const splitEvents = splitAbi
      .filter((entry) => entry.type === "event")
      .map((entry) => entry.name);

    expect(factoryEvents).to.include("SplitCreated");
    expect(splitEvents).to.have.members([
      "ParticipantJoined",
      "Funded",
      "DistributionFinalized",
      "Withdrawal",
    ]);
  });

  it("matches the argument names the model reads", function () {
    const splitAbi = require("../../frontend/EthSplit.abi.json");
    const argsOf = (name) =>
      splitAbi
        .find((entry) => entry.type === "event" && entry.name === name)
        .inputs.map((input) => input.name);

    expect(argsOf("ParticipantJoined")).to.include.members([
      "participant",
      "round",
    ]);
    expect(argsOf("Funded")).to.include.members(["round", "amount"]);
    expect(argsOf("DistributionFinalized")).to.include.members([
      "round",
      "totalDistributed",
      "participantCount",
      "amountPerParticipant",
      "remainderRemaining",
    ]);
    expect(argsOf("Withdrawal")).to.include.members(["participant", "amount"]);
  });

  it("documents that Withdrawal carries no round argument", function () {
    // The pipeline must never attribute a withdrawal to a round; this pins the
    // ABI fact that forces that restraint.
    const splitAbi = require("../../frontend/EthSplit.abi.json");
    const withdrawal = splitAbi.find(
      (entry) => entry.type === "event" && entry.name === "Withdrawal"
    );

    expect(withdrawal.inputs.map((i) => i.name)).to.not.include("round");
  });

  it("decodes real logs emitted by the deployed contracts", async function () {
    // Compile-and-emit locally: proves the ABI in frontend/ decodes what the
    // contracts actually emit, without touching Sepolia.
    const [manager, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SplitFactory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();

    const receipt = await (await factory.createSplit("Decode Check")).wait();
    const parsed = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((entry) => entry && entry.name === "SplitCreated");

    expect(parsed).to.not.be.undefined;

    const split = await ethers.getContractAt(
      "EthSplit",
      parsed.args.splitAddress
    );

    await split.connect(alice).join();
    await split.connect(bob).join();
    await split.fund({ value: ethers.parseEther("0.002") });
    await split.finalizeDistribution();
    await split.connect(alice).withdraw();

    const logs = await split.queryFilter("*", 0, "latest");
    const normalized = logs
      .filter((log) => log.fragment)
      .map((log) => normalizeLog(log, log.fragment.name));

    const names = normalized.map((log) => log.eventName);
    expect(names).to.include.members([
      "ParticipantJoined",
      "Funded",
      "DistributionFinalized",
      "Withdrawal",
    ]);

    normalized.forEach((log) => {
      expect(log.blockNumber).to.be.a("number");
      expect(log.transactionHash).to.match(/^0x[0-9a-f]{64}$/i);
    });
  });
});

describe("Intelligence — lifecycle reconstruction", function () {
  it("reconstructs a funded, finalized, partly withdrawn split", function () {
    const split = snapshotOf(fixtures.creatorRevenueShare);

    expect(split.rounds).to.have.lengthOf(1);
    expect(split.rounds[0].joinCount).to.equal(3);
    expect(split.rounds[0].fundedWei).to.equal(1000000000000000n);
    expect(split.rounds[0].finalized).to.equal(true);
    expect(split.rounds[0].finalizedParticipantCount).to.equal(3);
    expect(split.rounds[0].amountPerParticipantWei).to.equal(fixtures.SHARE);
    expect(split.rounds[0].remainderWei).to.equal(1n);

    expect(split.withdrawalCount).to.equal(1);
    expect(split.withdrawnTotalWei).to.equal(fixtures.SHARE);
    expect(split.outstandingClaimCount).to.equal(2);
    expect(split.lifecycleState).to.equal(LIFECYCLE.CLAIMS_OUTSTANDING);
    expect(split.badges).to.deep.equal([
      "Distribution Finalized",
      "Claims Outstanding",
    ]);
  });

  it("reconstructs a joined-but-unfunded split", function () {
    const split = snapshotOf(fixtures.productTeamBonus);

    expect(split.rounds[0].joinCount).to.equal(4);
    expect(split.rounds[0].finalized).to.equal(false);
    expect(split.outstandingClaimCount).to.equal(0);
    expect(split.lifecycleState).to.equal(LIFECYCLE.AWAITING_FUNDING);
    expect(split.badges).to.deep.equal(["Round Open", "Awaiting Funding"]);
  });

  it("reconstructs a fresh split with no events", function () {
    const split = snapshotOf(fixtures.freshSplit);

    expect(split.rounds).to.have.lengthOf(0);
    expect(split.lifecycleState).to.equal(LIFECYCLE.FRESH);
    expect(split.badges).to.deep.equal(["Round Open"]);
    expect(describeLifecycle(split)).to.equal(
      "Round 1 is open. No participants have joined yet."
    );
  });

  it("reconstructs a funded but unfinalized split", function () {
    const split = snapshotOf(fixtures.fundedNotFinalized);

    expect(split.rounds[0].fundedWei).to.equal(1000000000000000n);
    expect(split.rounds[0].finalized).to.equal(false);
    expect(split.lifecycleState).to.equal(LIFECYCLE.AWAITING_DISTRIBUTION);
    expect(describeLifecycle(split)).to.match(/open and funded with 0\.001 ETH/);
  });

  it("reports zero outstanding claims once everyone has withdrawn", function () {
    const split = snapshotOf(fixtures.fullyWithdrawn);

    expect(split.withdrawalCount).to.equal(3);
    expect(split.outstandingClaimCount).to.equal(0);
    expect(split.lifecycleState).to.equal(LIFECYCLE.FINALIZED);
    expect(split.badges).to.deep.equal(["Distribution Finalized"]);
    expect(describeLifecycle(split)).to.include("All claims have been withdrawn.");
  });

  it("treats a one-wei remainder as dust, not a balance", function () {
    const split = snapshotOf(fixtures.fullyWithdrawn);

    expect(split.roundPoolWei).to.equal(1n);
    expect(formatEth(split.roundPoolWei).text).to.equal("1 wei dust");
    expect(formatEth(split.roundPoolWei).dust).to.equal(true);
  });

  it("never says nobody joined about a finalized round", function () {
    const split = snapshotOf(fixtures.creatorRevenueShare);
    const text = describeLifecycle(split);

    expect(text).to.equal(
      "Round 1 finalized with 3 participants. Two claims remain outstanding. " +
        "Round 2 is open and currently has 0 joined participants."
    );
    expect(text).to.not.match(/no participants have joined/i);
  });

  it("flags an incomplete history rather than hiding it", function () {
    const split = snapshotOf(fixtures.creatorRevenueShare, {
      historyComplete: false,
    });
    const snapshot = factoryOf([split]);

    expect(snapshot.historyComplete).to.equal(false);

    QUESTIONS.forEach((question) => {
      const result = analyze(question.id, snapshot, {
        splitAddress: question.splitKey ? split.address : undefined,
      });

      expect(result.status, question.id).to.equal("partial");
      expect(result.note, question.id).to.match(/could not be read/i);
    });
  });
});

describe("Intelligence — answers", function () {
  const snapshot = () =>
    factoryOf([
      snapshotOf(fixtures.creatorRevenueShare),
      snapshotOf(fixtures.productTeamBonus),
    ]);

  it("defines exactly the five required guided questions", function () {
    expect(QUESTIONS.map((q) => q.label)).to.deep.equal([
      "Explain the factory",
      "Summarize recent activity",
      "Which splits are active?",
      "What ETH is currently held?",
      "Explain Creator Revenue Share",
    ]);
  });

  it("returns a structured answer for every question", function () {
    const current = snapshot();

    QUESTIONS.forEach((question) => {
      const result = analyze(question.id, current, {
        splitAddress: question.splitKey ? fixtures.SPLITS.creator : undefined,
      });

      expect(result, question.id).to.include.keys(
        "id",
        "title",
        "summary",
        "status",
        "facts",
        "evidence",
        "generatedAtBlock"
      );
      expect(result.summary, question.id).to.be.a("string").and.not.be.empty;
      expect(result.generatedAtBlock, question.id).to.equal(11585975);
      expect(result.status, question.id).to.equal("ok");
    });
  });

  it("attaches evidence to every required answer", function () {
    const current = snapshot();

    QUESTIONS.forEach((question) => {
      const result = analyze(question.id, current, {
        splitAddress: question.splitKey ? fixtures.SPLITS.creator : undefined,
      });

      expect(result.evidence, question.id).to.have.length.greaterThan(0);

      result.evidence.forEach((item) => {
        expect(item.etherscanUrl).to.match(/^https:\/\/sepolia\.etherscan\.io\//);
        expect(item).to.include.keys(
          "label",
          "type",
          "blockNumber",
          "transactionHash",
          "etherscanUrl"
        );
      });
    });
  });

  it("tags every fact with its provenance", function () {
    const current = snapshot();

    QUESTIONS.forEach((question) => {
      analyze(question.id, current, {
        splitAddress: question.splitKey ? fixtures.SPLITS.creator : undefined,
      }).facts.forEach((item) => {
        expect(["read", "event", "derived"], `${question.id}/${item.label}`).to.include(
          item.source
        );
      });
    });
  });

  it("explains the factory with version and split count", function () {
    const result = analyze("explain-factory", snapshot());

    expect(result.summary).to.include("v3.0.0");
    expect(result.summary).to.include("2 splits");
    expect(result.evidence[0].etherscanUrl).to.include(fixtures.FACTORY);
  });

  it("summarizes activity chronologically with real counts", function () {
    const result = analyze("recent-activity", snapshot());

    expect(result.summary).to.include("7 participant joins");
    expect(result.summary).to.include("1 funding transaction");
    expect(result.summary).to.include("1 finalized distribution");
    expect(result.summary).to.include("1 withdrawal");

    const blocks = result.evidence.map((item) => item.blockNumber);
    const sorted = [...blocks].sort((a, b) => a - b);
    expect(blocks).to.deep.equal(sorted, "evidence must be chronological");
  });

  it("distinguishes each split's lifecycle state", function () {
    const result = analyze("active-splits", snapshot());

    expect(result.facts).to.have.lengthOf(2);
    expect(result.facts[0].value).to.include("Two claims remain outstanding");
    expect(result.facts[1].value).to.include("Awaiting funding and distribution");
  });

  it("describes ETH as held, never as locked", function () {
    const result = analyze("eth-held", snapshot());

    expect(result.summary).to.include("currently held across the split contracts");
    expect(result.summary).to.not.match(/locked/i);
    expect(dump(result)).to.not.match(/locked/i);
  });

  it("explains dust without inflating it", function () {
    const result = analyze("eth-held", snapshot());

    expect(result.note).to.match(/1 wei of division remainder/);
    expect(result.note).to.match(/not a meaningful balance/i);
    expect(result.facts.map((f) => f.value)).to.include("1 wei dust");
  });

  it("walks the full Creator Revenue Share lifecycle with evidence", function () {
    const result = analyze("explain-creator-revenue-share", snapshot(), {
      splitAddress: fixtures.SPLITS.creator,
    });

    const values = result.facts.map((f) => f.value).join(" | ");

    expect(values).to.include("3 participants joined");
    expect(values).to.include("Pool funded with 0.001 ETH");
    expect(values).to.include("Finalized equally: 0.000333 ETH to each of 3 participants");
    expect(values).to.include("1 withdrawal completed");
    expect(values).to.include("Two claims remain outstanding");
    expect(values).to.include("Round 2 is open with 0 joined participants");

    // Every historical fact must be backed by a transaction.
    const withTx = result.evidence.filter((item) => item.transactionHash);
    expect(withTx.length).to.be.at.least(4);
  });

  it("returns an empty status when there is nothing to report", function () {
    const empty = factoryOf([]);

    expect(analyze("active-splits", empty).status).to.equal("empty");
    expect(analyze("recent-activity", empty).status).to.equal("empty");
  });
});

describe("Intelligence — no participant addresses escape", function () {
  it("keeps them out of every snapshot and answer", function () {
    const splits = [
      snapshotOf(fixtures.creatorRevenueShare),
      snapshotOf(fixtures.productTeamBonus),
      snapshotOf(fixtures.fullyWithdrawn),
    ];
    const current = factoryOf(splits);

    const answers = QUESTIONS.map((question) =>
      analyze(question.id, current, {
        splitAddress: question.splitKey ? fixtures.SPLITS.creator : undefined,
      })
    );

    const serialized = dump({ current, answers }).toLowerCase();

    fixtures.PARTICIPANTS.forEach((address) => {
      expect(
        serialized,
        `participant ${address} must not appear in snapshot or answers`
      ).to.not.include(address.toLowerCase());
    });
  });

  it("keeps them out of the generated frontend config", function () {
    const config = JSON.parse(fs.readFileSync(GENERATED_CONFIG, "utf8"));
    const serialized = dump(config);

    // Only the factory and the three split contracts may appear.
    const allowed = new Set(
      [config.factoryAddress, ...config.splits.map((s) => s.splitAddress)].map(
        (a) => a.toLowerCase()
      )
    );

    // Strip explorer tx URLs first: a 64-char hash contains a 40-char run that
    // would otherwise look like an address to a naive scan.
    const withoutTxUrls = serialized.replace(/\/tx\/0x[0-9a-fA-F]{64}/g, "");

    const found = [
      ...new Set(
        (withoutTxUrls.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) || []).map((a) =>
          a.toLowerCase()
        )
      ),
    ];

    expect(found.filter((a) => !allowed.has(a))).to.deep.equal([]);
  });

  it("keeps the manifest out of lifecycle facts entirely", function () {
    const config = JSON.parse(fs.readFileSync(GENERATED_CONFIG, "utf8"));

    config.splits.forEach((split) => {
      expect(split).to.not.have.property("lifecycleSummary");
      expect(split).to.not.have.property("onChainParticipantCount");
      expect(split).to.not.have.property("demoStatus");
      expect(split).to.not.have.property("participants");
    });
  });

  it("sources lifecycle facts from events, not manifest lifecycle values", function () {
    const source = fs.readFileSync(PAGE, "utf8");

    // The invariant is unchanged; only its location moved. Milestone 3 put the
    // event reconstruction on the server, so the page must consume the API's
    // derived fields and must not reach for manifest lifecycle data itself.
    expect(source).to.not.match(/lifecycleSummary/);
    expect(source).to.not.match(/DEMO_DEPLOYMENT/);
    expect(source).to.match(/split\.description/);
    expect(source).to.match(/split\.lifecycleExplanation/);
    expect(source).to.match(/createWeb3ApiClient/);
  });
});

describe("Intelligence — page remains read-only and model-free", function () {
  const source = () => fs.readFileSync(PAGE, "utf8");

  it("has no free-text input", function () {
    expect(source()).to.not.match(/<textarea|<input/i);
  });

  it("introduces no AI provider, endpoint or key", function () {
    const text = source();

    expect(text).to.not.match(/openai|anthropic|gemini|llm|chatbot/i);
    expect(text).to.not.match(/apiKey|API_KEY/);
    expect(text).to.not.match(/fetch\(|axios/);
  });

  it("uses no forbidden vocabulary", function () {
    const text = source();

    ["AI model", "LLM", "chatbot", "prediction", "autonomous"].forEach((term) => {
      expect(text.toLowerCase()).to.not.include(term.toLowerCase());
    });
  });

  it("connects no wallet and signs nothing", function () {
    const text = source();

    expect(text).to.not.match(/window\.ethereum|getSigner|eth_requestAccounts/);
    expect(text).to.not.match(/useWeb3Wallet/);
    expect(text).to.not.match(/\.connect\(|sendTransaction|writeContract/);
  });

  it("states the read-only guarantee to the visitor", function () {
    const text = source();

    expect(text).to.include("No wallet connection");
    expect(text).to.include("No transaction execution");
    expect(text).to.include("Sepolia testnet only");
    expect(text).to.include(
      "Read-only explanations generated from live contract state and"
    );
  });

  it("renders loading, error, retry and empty states", function () {
    const text = source();

    expect(text).to.match(/answerLoading/);
    expect(text).to.match(/answerError/);
    expect(text).to.match(/Retry/);
    expect(text).to.match(/Choose a question above/);
    expect(text).to.match(/aria-live="polite"/);
    expect(text).to.match(/aria-pressed=/);
  });

  it("makes no provider at all now that the API serves the data", function () {
    // Milestone 2 required exactly one pinned provider, reused across
    // questions. Milestone 3 removed the browser's chain access entirely, so
    // the stronger assertion is that no provider is constructed at all.
    const text = source();

    expect(text.match(/new ethers\.JsonRpcProvider/g) || []).to.have.lengthOf(0);
    expect(text).to.not.match(/providerRef/);
    expect(text).to.match(/createWeb3ApiClient/);
  });
});

describe("Intelligence — snapshot cache", function () {
  it("serves a cached snapshot without reloading", async function () {
    const cache = createSnapshotCache({ ttlMs: 60000 });
    let loads = 0;

    const load = async () => {
      loads += 1;
      return { generatedAtBlock: 100 };
    };

    await cache.get(load, { latestBlock: 100 });
    await cache.get(load, { latestBlock: 100 });

    expect(loads).to.equal(1);
  });

  it("rebuilds when the chain has advanced", async function () {
    const cache = createSnapshotCache({ ttlMs: 60000 });
    let loads = 0;

    const load = async () => {
      loads += 1;
      return { generatedAtBlock: 100 + loads };
    };

    await cache.get(load, { latestBlock: 100 });
    await cache.get(load, { latestBlock: 105 });

    expect(loads).to.equal(2);
  });

  it("expires after the TTL", async function () {
    const cache = createSnapshotCache({ ttlMs: 1 });
    let loads = 0;

    const load = async () => {
      loads += 1;
      return { generatedAtBlock: 100 };
    };

    await cache.get(load, { latestBlock: 100 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.get(load, { latestBlock: 100 });

    expect(loads).to.equal(2);
  });

  it("collapses concurrent requests onto one load", async function () {
    const cache = createSnapshotCache();
    let loads = 0;

    const load = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { generatedAtBlock: 100 };
    };

    await Promise.all([cache.get(load), cache.get(load), cache.get(load)]);

    expect(loads).to.equal(1);
  });
});

describe("Intelligence — partial RPC failure", function () {
  /** A contract stub whose log queries fail but whose reads succeed. */
  const stubContract = (address, { failLogs = false } = {}) => ({
    filters: {
      SplitCreated: () => ({}),
      ParticipantJoined: () => ({}),
      Funded: () => ({}),
      DistributionFinalized: () => ({}),
      Withdrawal: () => ({}),
    },
    queryFilter: async () => {
      if (failLogs) throw new Error("log query rejected by RPC");
      return [];
    },
    getFactoryInfo: async () => ["3.0.0", 1n, 20n, 100n],
    getSplits: async () => [[{ splitAddress: address }], 1n],
    title: async () => "Degraded Split",
    VERSION: async () => "3.0.0",
    round: async () => 1n,
    participantCount: async () => 2n,
    contractBalance: async () => 0n,
    availableForDistribution: async () => 0n,
    totalClaimable: async () => 0n,
  });

  it("still returns current state when logs cannot be read", async function () {
    const address = fixtures.SPLITS.bonus;

    const snapshot = await loadFactorySnapshot({
      provider: { getBlockNumber: async () => 11585975 },
      createContract: () => stubContract(address, { failLogs: true }),
      factoryAddress: fixtures.FACTORY,
      factoryAbi: [],
      splitAbi: [],
      deploymentBlock: 11585248,
    });

    expect(snapshot.historyComplete).to.equal(false);
    expect(snapshot.warnings.length).to.be.greaterThan(0);
    expect(snapshot.splits[0].currentParticipantCount).to.equal(2);

    const result = analyze("active-splits", snapshot);
    expect(result.status).to.equal("partial");
    expect(result.note).to.match(/could not be read/i);
  });

  it("marks history complete when every query succeeds", async function () {
    const snapshot = await loadFactorySnapshot({
      provider: { getBlockNumber: async () => 11585975 },
      createContract: () => stubContract(fixtures.SPLITS.bonus),
      factoryAddress: fixtures.FACTORY,
      factoryAbi: [],
      splitAbi: [],
      deploymentBlock: 11585248,
    });

    expect(snapshot.historyComplete).to.equal(true);
    expect(snapshot.warnings).to.deep.equal([]);
    expect(analyze("active-splits", snapshot).status).to.equal("ok");
  });
});

describe("Intelligence — formatting stability", function () {
  it("formats the deployed balances exactly", function () {
    expect(formatEth(666666666666667n).text).to.equal("0.000667 ETH");
    expect(formatEth(666666666666666n).text).to.equal("0.000667 ETH");
    expect(formatEth(1000000000000000n).text).to.equal("0.001 ETH");
    expect(formatEth(333333333333333n).text).to.equal("0.000333 ETH");
    expect(formatEth(0n).text).to.equal("0 ETH");
    expect(formatEth(1n).text).to.equal("1 wei dust");
  });

  it("abbreviates transaction hashes for evidence rows", function () {
    expect(
      abbreviateHash(
        "0x47b4b2c1547302523383c42ee2d010e603e1054523a7ee7024ad9fcb1f793901"
      )
    ).to.equal("0x47b4b2c1…793901");
  });

  it("keeps the documented address abbreviation", function () {
    expect(abbreviateAddress(fixtures.FACTORY)).to.equal("0xbddD…008eA");
  });
});
