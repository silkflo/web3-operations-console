// ethereum-v3/test/demo/ConsoleUI.test.js
//
// Guards for the console homepage's presentation layer.
//
// Two kinds of check:
//   1. SOURCE checks — the page must not reintroduce overclaiming copy or a
//      fake AI input. These read pages/index.js as text, which is blunt but
//      catches the regression that actually matters: someone pasting the old
//      badges or an "Ask AI" control back in.
//   2. BEHAVIOUR checks — the formatting and lifecycle-interpretation helpers
//      are re-implemented here against the same rules and exercised with the
//      real deployed values, so a change in intent fails loudly.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "..", "..", "pages", "index.js");
const DEPLOYMENT = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "demo-deployment.json"
);

const source = () => fs.readFileSync(PAGE, "utf8");
const deployment = () => JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));

describe("Console UI — hero makes no unsupported claims", function () {
  it("states only the four truthful badges", function () {
    const text = source();

    [
      "Live Blockchain Data",
      "Verified Smart Contracts",
      "Human-Controlled Design",
    ].forEach((badge) => {
      expect(text, `missing badge: ${badge}`).to.include(badge);
    });

    // The environment label badge comes from shared config.
    expect(text).to.include("ENVIRONMENT_LABEL");
  });

  it("does not claim AI or human-signing in the hero", function () {
    const text = source();

    expect(text).to.not.match(/AI[- ]POWERED/i);
    expect(text).to.not.match(/HUMAN[- ]SIGNED/i);

    // "INDEXED DATA" was banned as a hero badge because no indexer existed.
    // Milestone 3 built one, so words like "Indexed block" are now truthful —
    // but the badge itself must still be the four agreed claims only.
    const badges = text.slice(
      text.indexOf("hero-badges"),
      text.indexOf("hero-title")
    );

    expect(badges).to.not.match(/INDEXED DATA/i);
    expect(badges).to.not.match(/AI/);
  });

  it("does not claim production-grade, audited, or custodial status", function () {
    // The old subtitle said "Production-grade Ethereum operations".
    const text = source();

    expect(text).to.not.match(/production-grade/i);
    expect(text).to.not.match(/\baudited\b/i);
    expect(text).to.not.match(/\bcustody\b/i);
    expect(text).to.not.match(/institutional/i);
  });

  it("uses the agreed title and subtitle", function () {
    const text = source();

    expect(text).to.include("Web3 Operations Console");
    expect(text).to.include(
      "A read-only Sepolia demo for inspecting equal-split smart contracts"
    );
  });

  it("keeps an explicit testnet disclaimer", function () {
    const text = source();

    expect(text).to.include("Testnet only");
    expect(text).to.match(/no monetary value/i);
    expect(text).to.match(/not\s+received a professional external audit/i);
  });
});

describe("Console UI — no fake AI surface", function () {
  it("has no textarea and no Ask AI action", function () {
    const text = source();

    expect(text).to.not.match(/<textarea/i);
    expect(text).to.not.match(/Ask AI/i);
    expect(text).to.not.match(/aiInput|setAiInput|handleAIQuery/);
  });

  it("presents the functional Contract Intelligence panel", function () {
    // Milestone 2 replaced the placeholder with real guided analysis. The panel
    // must still describe itself honestly and offer no free-text entry point.
    const text = source();

    expect(text).to.include("Contract Intelligence");
    expect(text).to.include(
      "Read-only explanations generated from live contract state and"
    );
    expect(text).to.include("Guided questions");
    expect(text).to.match(/No wallet connection/);
    expect(text).to.match(/No transaction execution/);
    expect(text).to.not.match(/being added in the next milestone/);
  });

  it("makes no network call to an AI endpoint", function () {
    const text = source();

    expect(text).to.not.match(/fetch\(/);
    expect(text).to.not.match(/\/api\/(ai|chat|analy)/i);
    expect(text).to.not.match(/openai|anthropic|claude/i);
  });
});

describe("Console UI — address abbreviation", function () {
  // Mirrors abbreviateAddress in pages/index.js.
  const abbreviate = (address) =>
    typeof address === "string" && address.length > 12
      ? `${address.slice(0, 6)}…${address.slice(-5)}`
      : address || "";

  it("abbreviates the deployed factory as documented", function () {
    expect(abbreviate("0xbddD01aE6B2899c507DD540E6437552006f008eA")).to.equal(
      "0xbddD…008eA"
    );
  });

  it("keeps the 0x prefix and the trailing characters", function () {
    const address = deployment().factoryAddress;
    const short = abbreviate(address);

    expect(short.startsWith("0x")).to.equal(true);
    expect(short.endsWith(address.slice(-5))).to.equal(true);
    expect(short).to.have.lengthOf(12);
  });

  it("leaves short strings untouched", function () {
    expect(abbreviate("0x1234")).to.equal("0x1234");
    expect(abbreviate("")).to.equal("");
    expect(abbreviate(undefined)).to.equal("");
  });

  it("exposes the full address for copy and never truncates it in the label", function () {
    const text = source();

    // The copy control's accessible name must carry the whole address.
    expect(text).to.match(/aria-label=\{`Copy full \$\{label\} address \$\{address\}`\}/);
    expect(text).to.match(/navigator\.clipboard\.writeText\(address\)/);
    expect(text).to.match(/aria-live="polite"/);
  });
});

describe("Console UI — ETH formatting", function () {
  // Mirrors formatEth in pages/index.js.
  const WEI_PER_ETH = 1000000000000000000n;
  const DUST_THRESHOLD_WEI = 1000n;

  const formatEth = (wei) => {
    if (typeof wei !== "bigint") return { text: "—", dust: false, zero: true };
    if (wei === 0n) return { text: "0 ETH", dust: false, zero: true };
    if (wei < DUST_THRESHOLD_WEI)
      return { text: `${wei.toString()} wei dust`, dust: true, zero: false };

    const scaled = (wei * 1000000n + WEI_PER_ETH / 2n) / WEI_PER_ETH;
    if (scaled === 0n)
      return { text: "< 0.000001 ETH", dust: false, zero: false };

    const whole = scaled / 1000000n;
    const fraction = (scaled % 1000000n)
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "");

    return {
      text: fraction ? `${whole}.${fraction} ETH` : `${whole} ETH`,
      dust: false,
      zero: false,
    };
  };

  it("formats the live finalized balance to six decimals", function () {
    // Real on-chain value for Creator Revenue Share.
    expect(formatEth(666666666666667n).text).to.equal("0.000667 ETH");
  });

  it("formats the seeded funding amount cleanly", function () {
    expect(formatEth(1000000000000000n).text).to.equal("0.001 ETH");
  });

  it("never renders a long decimal string", function () {
    [
      666666666666667n,
      666666666666666n,
      1000000000000000n,
      123456789012345678n,
      WEI_PER_ETH,
    ].forEach((wei) => {
      const { text } = formatEth(wei);
      const decimals = text.includes(".") ? text.split(".")[1].split(" ")[0] : "";
      expect(decimals.length, `too many decimals in "${text}"`).to.be.at.most(6);
    });
  });

  it("labels a single wei as dust rather than 0 ETH", function () {
    const result = formatEth(1n);

    expect(result.text).to.equal("1 wei dust");
    expect(result.dust).to.equal(true);
  });

  it("treats a true zero as zero, not dust", function () {
    const result = formatEth(0n);

    expect(result.text).to.equal("0 ETH");
    expect(result.dust).to.equal(false);
    expect(result.zero).to.equal(true);
  });

  it("rounds rather than truncating", function () {
    // 0.0000005 ETH must round up, not disappear.
    expect(formatEth(500000000000n).text).to.equal("0.000001 ETH");
  });

  it("renders whole ETH without a trailing dot", function () {
    expect(formatEth(WEI_PER_ETH).text).to.equal("1 ETH");
    expect(formatEth(2n * WEI_PER_ETH).text).to.equal("2 ETH");
  });
});

describe("Console UI — lifecycle interpretation", function () {
  // Mirrors deriveLifecycle in pages/index.js.
  const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];
  const numberWord = (v) =>
    v >= 0 && v < NUMBER_WORDS.length ? NUMBER_WORDS[v] : String(v);
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  const deriveLifecycle = (split, summary) => {
    const round = Number(split.round);
    const participants = Number(split.participantCount);
    const badges = [];
    let explanation = "";

    if (round > 1) {
      badges.push({ label: "Distribution Finalized", tone: "done" });
      if (split.totalClaimableWei > 0n)
        badges.push({ label: "Claims Outstanding", tone: "warn" });

      const finalizedRound = round - 1;
      const joined = summary ? summary.joined : null;
      const withdrawals = summary ? summary.withdrawals : 0;
      const sentences = [];

      sentences.push(
        joined
          ? `Round ${finalizedRound} finalized with ${plural(joined, "participant")}.`
          : `Round ${finalizedRound} was finalized.`
      );

      if (joined) {
        const outstanding = joined - withdrawals;
        sentences.push(
          outstanding === 0
            ? "All claims have been withdrawn."
            : `${numberWord(outstanding)} claim${
                outstanding === 1 ? "" : "s"
              } remain outstanding.`
        );
      }

      sentences.push(
        `Round ${round} is open and currently has ${plural(
          participants,
          "joined participant"
        )}.`
      );

      explanation = sentences.join(" ");
    } else if (participants > 0 && split.roundPoolWei > 0n) {
      badges.push({ label: "Round Open", tone: "live" });
      badges.push({ label: "Awaiting Distribution", tone: "warn" });
      explanation = `Round ${round} is open and funded. ${plural(
        participants,
        "participant"
      )} have joined. Awaiting finalization.`;
    } else if (participants > 0) {
      badges.push({ label: "Round Open", tone: "live" });
      badges.push({ label: "Awaiting Funding", tone: "warn" });
      explanation = `Round ${round} is open. ${plural(
        participants,
        "participant"
      )} have joined. Awaiting funding and distribution.`;
    } else {
      badges.push({ label: "Round Open", tone: "live" });
      explanation = `Round ${round} is open. No participants have joined yet.`;
    }

    return { badges, explanation };
  };

  it("explains the finalized split exactly as specified", function () {
    const { badges, explanation } = deriveLifecycle(
      {
        round: "2",
        participantCount: "0",
        totalClaimableWei: 666666666666666n,
        roundPoolWei: 1n,
      },
      { joined: 3, withdrawals: 1, finalized: true, funded: true }
    );

    expect(explanation).to.equal(
      "Round 1 finalized with 3 participants. Two claims remain outstanding. " +
        "Round 2 is open and currently has 0 joined participants."
    );

    expect(badges.map((b) => b.label)).to.deep.equal([
      "Distribution Finalized",
      "Claims Outstanding",
    ]);
  });

  it("never implies that 0 current participants means nobody joined", function () {
    const { explanation } = deriveLifecycle(
      { round: "2", participantCount: "0", totalClaimableWei: 1n, roundPoolWei: 0n },
      { joined: 3, withdrawals: 1 }
    );

    expect(explanation).to.match(/finalized with 3 participants/);
    expect(explanation).to.not.match(/no participants have joined/i);
  });

  it("explains an open unfunded round as specified", function () {
    const { badges, explanation } = deriveLifecycle(
      { round: "1", participantCount: "4", totalClaimableWei: 0n, roundPoolWei: 0n },
      { joined: 4, withdrawals: 0 }
    );

    expect(explanation).to.equal(
      "Round 1 is open. 4 participants have joined. Awaiting funding and distribution."
    );

    expect(badges.map((b) => b.label)).to.deep.equal([
      "Round Open",
      "Awaiting Funding",
    ]);
  });

  it("drops Claims Outstanding once everything is withdrawn", function () {
    const { badges, explanation } = deriveLifecycle(
      { round: "2", participantCount: "0", totalClaimableWei: 0n, roundPoolWei: 0n },
      { joined: 3, withdrawals: 3 }
    );

    expect(badges.map((b) => b.label)).to.deep.equal(["Distribution Finalized"]);
    expect(explanation).to.include("All claims have been withdrawn.");
  });

  it("marks a funded but unfinalized round as awaiting distribution", function () {
    const { badges } = deriveLifecycle(
      {
        round: "1",
        participantCount: "3",
        totalClaimableWei: 0n,
        roundPoolWei: 1000000000000000n,
      },
      { joined: 3, withdrawals: 0 }
    );

    expect(badges.map((b) => b.label)).to.deep.equal([
      "Round Open",
      "Awaiting Distribution",
    ]);
  });

  it("handles an empty split without inventing participants", function () {
    const { badges, explanation } = deriveLifecycle(
      { round: "1", participantCount: "0", totalClaimableWei: 0n, roundPoolWei: 0n },
      { joined: 0, withdrawals: 0 }
    );

    expect(badges.map((b) => b.label)).to.deep.equal(["Round Open"]);
    expect(explanation).to.equal(
      "Round 1 is open. No participants have joined yet."
    );
  });

  it("only uses badge labels the milestone sanctions", function () {
    const allowed = [
      "Round Open",
      "Awaiting Funding",
      "Awaiting Distribution",
      "Distribution Finalized",
      "Claims Outstanding",
    ];

    const cases = [
      [{ round: "2", participantCount: "0", totalClaimableWei: 1n, roundPoolWei: 0n }, { joined: 3, withdrawals: 1 }],
      [{ round: "1", participantCount: "4", totalClaimableWei: 0n, roundPoolWei: 0n }, { joined: 4, withdrawals: 0 }],
      [{ round: "1", participantCount: "0", totalClaimableWei: 0n, roundPoolWei: 0n }, null],
    ];

    cases.forEach(([split, summary]) => {
      deriveLifecycle(split, summary).badges.forEach((badge) => {
        expect(allowed, `unexpected badge ${badge.label}`).to.include(badge.label);
      });
    });
  });

  it("takes no lifecycle facts from the generated config", function () {
    // Milestone 2 reconstructs joins, funding, finalization and withdrawals from
    // event logs. The config must carry scenario prose and addresses only, so a
    // stale snapshot can never contradict the chain.
    deployment().splits.forEach((split) => {
      expect(Object.keys(split).sort()).to.deep.equal([
        "allocation",
        "description",
        "key",
        "splitAddress",
        "title",
      ]);
    });
  });
});

describe("Console UI — responsive and accessible structure", function () {
  it("declares mobile breakpoints", function () {
    const text = source();

    expect(text).to.match(/@media \(max-width: 900px\)/);
    expect(text).to.match(/@media \(max-width: 640px\)/);
  });

  it("uses fluid grids rather than fixed widths", function () {
    const text = source();

    expect(text).to.match(/repeat\(auto-fit, minmax\(/);
    expect(text).to.match(/grid-template-columns: minmax\(0, 1fr\)/);
  });

  it("sizes type in absolute units so a host root font-size cannot shrink it", function () {
    const text = source();
    const styleStart = text.indexOf("<style jsx>");
    const styles = text.slice(styleStart);

    // Originally a guard against semantic-ui-css setting the root to 14px.
    // Semantic UI is gone, but styles/globals.css still sets a 14px body size
    // to preserve the portfolio's typography, so rem units would silently
    // rescale the whole console. Keep the page sized in px.
    expect(
      styles,
      "rem units are unreliable here: the global stylesheet sets a 14px base"
    ).to.not.match(/\d+(\.\d+)?rem/);
  });

  it("uses semantic landmarks and an ordered heading hierarchy", function () {
    const text = source();

    expect(text).to.match(/<main/);
    expect(text).to.match(/<section/);
    expect(text).to.match(/<aside/);
    expect(text).to.match(/<h1/);
    expect(text).to.match(/aria-labelledby=/);
  });

  it("keeps focus visible and provides screen-reader affordances", function () {
    const text = source();

    expect(text).to.match(/:focus-visible/);
    expect(text).to.match(/\.sr-only/);
    expect(text).to.match(/opens in a new tab/);
  });

  it("adds no runtime dependency to render the console", function () {
    const text = source();
    // Every bare (non-relative) module the page pulls in, including the
    // side-effect CSS import, which has no `from` clause.
    const specifiers = [...text.matchAll(/^import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/gm)]
      .map((match) => match[1])
      .filter((name) => !name.startsWith("."));

    // ethers left the browser bundle in Milestone 3: the page reads the
    // indexed API instead of scanning event logs itself. semantic-ui-css left
    // with the standalone extraction: its few used styles are now local CSS in
    // styles/globals.css, imported once from pages/_app.js.
    expect([...new Set(specifiers)].sort()).to.deep.equal([
      "next/head",
      "react",
    ]);
  });
});
