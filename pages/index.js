// pages/index.js
//
// Read-only Sepolia console: the homepage of the standalone Web3 Operations
// Console (https://web3.flo-portfolio.com).
//
// Truthfulness rules for anything rendered here:
//   - claim only what the deployed system actually does today;
//   - participant counts and balances come from live contract reads;
//   - the number who joined a FINALIZED round can only come from the recorded
//     lifecycle summary, because finalizeDistribution() clears the participant
//     list on-chain. Never present a post-finalization 0 as "nobody joined".

import React, { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";

import Header from "../components/Header";

import {
  ENVIRONMENT_LABEL,
  SEPOLIA_EXPLORER,
} from "../ethereum-v3/frontend/config";

import {
  abbreviateAddress,
  abbreviateHash,
  formatEth,
} from "../lib/contract-intelligence/format";
import { QUESTIONS } from "../lib/contract-intelligence/constants";
import {
  createWeb3ApiClient,
  describeFreshness,
  describeDataState,
} from "../lib/web3-api-client";
import {
  createDashboardPoller,
  resolveRefreshIntervalMs,
} from "../lib/dashboard-poller";

/**
 * How often the page refreshes itself.
 *
 * Was 15 seconds against three endpoints at once. Each refresh cost 3 HTTP
 * requests and about 45 JSON-RPC operations, so a continuously open, visible
 * tab made roughly 12 requests and 180 RPC operations a minute — the load that
 * turned an RPC rate limit into an unreachable dashboard. Nothing on this page
 * changes that fast: the contracts are a fixed testnet demo. Configurable at
 * build time with NEXT_PUBLIC_WEB3_REFRESH_MS, clamped to 30s-10min.
 */
const POLL_INTERVAL_MS = resolveRefreshIntervalMs();

/** Refresh interval in seconds, for the tile note. */
const POLL_INTERVAL_LABEL = `${Math.round(POLL_INTERVAL_MS / 1000)}s`;

/** Single API client for the page. No RPC, no Prisma, no database. */
const api = createWeb3ApiClient();

/** Copy-to-clipboard control with a live-region announcement. */
const CopyAddress = ({ address, label }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions; the full address is still
      // reachable via the Etherscan link, so fail quietly rather than alarm.
      setCopied(false);
    }
  };

  return (
    <span className="copy-wrap">
      <code className="mono">{abbreviateAddress(address)}</code>
      <button
        type="button"
        className="copy-btn"
        onClick={copy}
        aria-label={`Copy full ${label} address ${address}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${label} address copied to clipboard` : ""}
      </span>
    </span>
  );
};

const ANSWER_TONES = { ok: "done", partial: "warn", empty: "live" };

const ANSWER_STATUS_LABELS = {
  ok: "Grounded",
  partial: "Partial evidence",
  empty: "No data",
};

const SOURCE_TITLES = {
  read: "Live contract read",
  event: "Decoded on-chain event log",
  derived: "Derived from reads and events",
};

/** Maps the model's badge labels onto visual tones. */
const BADGE_TONES = {
  "Round Open": "live",
  "Awaiting Funding": "warn",
  "Awaiting Distribution": "warn",
  "Distribution Finalized": "done",
  "Claims Outstanding": "warn",
};

const StatusBadge = ({ label, tone }) => (
  <span className={`badge badge-${tone}`}>{label}</span>
);

const StatTile = ({ icon, label, value, note, tone }) => (
  <div className="tile">
    <div className="tile-label">
      <span aria-hidden="true" className="tile-icon">
        {icon}
      </span>
      {label}
    </div>
    <div className={`tile-value${tone ? ` tone-${tone}` : ""}`}>{value}</div>
    {note ? <div className="tile-note">{note}</div> : null}
  </div>
);

// ============ DATA ============

const Web3Console = () => {
  // Dashboard state, all sourced from the indexed API.
  const [splitsPayload, setSplitsPayload] = useState(null);
  const [summary, setSummary] = useState(null);
  const [health, setHealth] = useState(null);
  const [freshness, setFreshness] = useState(null);
  const [loadingSplits, setLoadingSplits] = useState(true);
  const [networkStatus, setNetworkStatus] = useState("checking");
  const [error, setError] = useState(null);

  // Contract Intelligence panel state.
  const [selectedQuestion, setSelectedQuestion] = useState(null);
  const [answer, setAnswer] = useState(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState(null);

  const isMountedRef = useRef(true);
  const pollerRef = useRef(null);
  const hasDataRef = useRef(false);

  /**
   * Loads the dashboard from the API.
   *
   * One request. Splits, summary and index health all come from the same
   * server-side snapshot, so every figure on the page describes one moment
   * rather than three slightly different ones.
   *
   * A failure never blanks the page: whatever was last displayed stays, with
   * the error shown beside it. An empty dashboard is strictly worse than a
   * clearly-labelled stale one.
   */
  const loadDashboardData = useCallback(async ({ reason } = {}) => {
    if (!api.isConfigured()) {
      setNetworkStatus("not-configured");
      setError(null);
      setSplitsPayload(null);
      setSummary(null);
      setHealth(null);
      setFreshness(null);
      setLoadingSplits(false);
      return;
    }

    if (!hasDataRef.current) {
      setLoadingSplits(true);
    }

    try {
      const payload = await api.dashboard();

      if (!isMountedRef.current) {
        return;
      }

      hasDataRef.current = true;

      setSplitsPayload({
        generatedAtBlock: payload.generatedAtBlock,
        splits: payload.splits || [],
        warnings: payload.warnings || [],
      });

      // Provenance travels with the figures. Without it the page cannot tell
      // "read from the chain" from "reconstructed because the chain was
      // unreachable", and would describe both as live.
      setFreshness(payload.freshness || null);

      // Optional sections keep their previous values when this refresh could
      // not produce them, rather than reverting to "Loading...".
      if (payload.summary) {
        setSummary(payload.summary);
      }

      if (payload.health) {
        setHealth(payload.health);
      }

      // Connected to the API. Whether the DATA is live is a separate question,
      // answered by describeDataState below — a 200 response proves only that
      // the API answered.
      setNetworkStatus("connected");

      const warnings = payload.warnings || [];

      setError(
        warnings.length > 0
          ? {
              title: "Some data could not be refreshed",
              message: warnings.join(" "),
            }
          : null
      );
    } catch (loadError) {
      console.error("Dashboard load error:", loadError);

      if (!isMountedRef.current) {
        return;
      }

      // Keep showing what we have; only the banner changes.
      setNetworkStatus(hasDataRef.current ? "degraded" : "error");
      setError({
        title: hasDataRef.current
          ? "Could not refresh from the Web3 API"
          : "Unable to reach the Web3 API",
        message: hasDataRef.current
          ? `${loadError.message} The figures below are from the last ` +
            "successful refresh and are not current."
          : loadError.message,
      });
    } finally {
      if (isMountedRef.current) {
        setLoadingSplits(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    // Refreshes never overlap, pause while the tab is hidden and resume when it
    // is shown again. See lib/dashboard-poller.js.
    const poller = createDashboardPoller({
      load: loadDashboardData,
      intervalMs: POLL_INTERVAL_MS,
    });

    pollerRef.current = poller;
    poller.start();

    return () => {
      isMountedRef.current = false;
      poller.stop();
      pollerRef.current = null;
    };
  }, [loadDashboardData]);

  /** Manual retry. Joins an in-flight refresh rather than starting a second. */
  const retry = useCallback(() => {
    if (pollerRef.current) {
      return pollerRef.current.refresh({ reason: "manual" });
    }

    return loadDashboardData({ reason: "manual" });
  }, [loadDashboardData]);

  /** Asks one guided question. The analysis runs server-side, on indexed data. */
  const askQuestion = useCallback(async (question) => {
    setSelectedQuestion(question.id);
    setAnswerLoading(true);
    setAnswerError(null);
    setAnswer(null);

    try {
      const result = await api.intelligence(question.id);

      if (isMountedRef.current) {
        setAnswer(result);
      }
    } catch (questionError) {
      console.error("Intelligence error:", questionError);

      if (isMountedRef.current) {
        setAnswerError(questionError.message);
      }
    } finally {
      if (isMountedRef.current) {
        setAnswerLoading(false);
      }
    }
  }, []);

  const splits = splitsPayload ? splitsPayload.splits : [];
  const factoryAddress = summary ? summary.factory.address : null;
  const factoryInfo = summary
    ? {
        version: summary.factory.version,
        deployedSplits: String(summary.factory.deployedSplitCount),
      }
    : null;
  const latestBlock = health ? health.latestChainBlock : null;
  const indexedBlock = health ? health.latestIndexedBlock : null;
  const indexFreshness = describeFreshness(health);

  // What the figures on this page actually are, decided from the payload's own
  // provenance rather than from the fact that a request succeeded.
  const dataState = describeDataState(
    splitsPayload ? { freshness, health } : null
  );

  // A refresh that failed outright leaves the previous payload in place, and
  // that payload may well say "live" — it was, when it was fetched. It is not
  // live now, so a failed refresh disqualifies the claim regardless.
  const isLiveData = dataState.isLive && networkStatus !== "degraded";

  const isNotConfigured = networkStatus === "not-configured";

  const statusPlaceholder = isNotConfigured
    ? "—"
    : networkStatus === "error"
    ? "Unavailable"
    : "Loading…";

  /**
   * The tile reports the DATA, not the connection.
   *
   * These are two different failures and the page has to separate them: the API
   * can be perfectly reachable while every contract read behind it is failing.
   * The value says what the figures are; the note says what the connection is.
   */
  const dataStatus = isNotConfigured
    ? { value: "Not configured", tone: "muted", note: "No API configured" }
    : networkStatus === "checking"
    ? { value: "Checking…", tone: "muted", note: "Connecting to read API" }
    : networkStatus === "error"
    ? { value: "Error", tone: "bad", note: "Read API unreachable" }
    : isLiveData
    ? { value: "Live", tone: "ok", note: "Read API connected · live contract reads" }
    : {
        value: dataState.label,
        tone: dataState.level === "stale" ? "bad" : "warn",
        note:
          networkStatus === "degraded"
            ? "Read API unreachable · showing last successful data"
            : "Read API connected · live contract reads unavailable",
      };

  const statusValue = dataStatus.value;
  const statusTone = dataStatus.tone;
  const statusNote = dataStatus.note;

  return (
    <>
      <Head>
        <title>Web3 Operations Console — Sepolia Demo</title>
         <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta
          name="description"
          content="A read-only Sepolia testnet console for inspecting equal-split smart contracts: verified contracts, live balances, lifecycle state and linked on-chain evidence. Testnet only — no real funds."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="canonical" href="https://web3.flo-portfolio.com" />
      </Head>

      <Header />

      <main className="console">
        {/* ============ HERO ============ */}
        <section className="hero" aria-labelledby="console-title">
          <ul className="hero-badges" aria-label="Demo characteristics">
            <li className="hero-badge hero-badge-primary">{ENVIRONMENT_LABEL}</li>
            {/* Only claimed when the payload says the reads succeeded. */}
            <li className="hero-badge">
              {isLiveData ? "Live Blockchain Data" : "Indexed Blockchain Data"}
            </li>
            <li className="hero-badge">Verified Smart Contracts</li>
            <li className="hero-badge">Human-Controlled Design</li>
          </ul>

          <h1 id="console-title" className="hero-title">
            Web3 Operations Console
          </h1>

          <p className="hero-subtitle">
            A read-only Sepolia demo for inspecting equal-split smart contracts,
            live balances, lifecycle state, and on-chain evidence.
          </p>
        </section>

        {/* ============ SUMMARY TILES ============ */}
        <section className="tiles" aria-label="Environment summary">
          <StatTile
            icon="◉"
            label="Network status"
            value={statusValue}
            note={statusNote}
            tone={statusTone}
          />
          <StatTile
            icon="⛓"
            label="Latest block"
            value={latestBlock ? `#${latestBlock.toLocaleString()}` : statusPlaceholder}
            note={latestBlock ? `Refreshes every ${POLL_INTERVAL_LABEL}` : null}
          />
          <StatTile
            icon="◫"
            label="Deployed splits"
            value={factoryInfo ? factoryInfo.deployedSplits : statusPlaceholder}
            note={factoryInfo ? "Tracked by the factory" : null}
          />
          <StatTile
            icon="✓"
            label="Contract version"
            value={factoryInfo ? `v${factoryInfo.version}` : statusPlaceholder}
            note={factoryInfo ? "Factory and splits" : null}
          />
        </section>

        {/* ============ INDEX STATUS ============ */}
        {health && (
          <div
            className={`freshness freshness-${indexFreshness.level}`}
            role="status"
          >
            <div className="freshness-main">
              <span className="freshness-dot" aria-hidden="true" />
              <strong>{indexFreshness.label}</strong>
              {indexFreshness.detail ? (
                <span className="freshness-detail">{indexFreshness.detail}</span>
              ) : null}
            </div>
            <dl className="freshness-facts">
              <div>
                <dt>Indexed block</dt>
                <dd>
                  {indexedBlock !== null
                    ? `#${indexedBlock.toLocaleString()}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Indexer status</dt>
                <dd>{health.status}</dd>
              </div>
              <div>
                <dt>Last synchronized</dt>
                <dd>
                  {health.secondsSinceSync !== null
                    ? `${Math.round(health.secondsSinceSync)}s ago`
                    : "never"}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {/* ============ NOT DEPLOYED ============ */}
        {isNotConfigured && (
          <div className="notice" role="status">
            <strong>Web3 API not configured</strong>
            <p>
              This deployment has no <code>NEXT_PUBLIC_WEB3_API_URL</code>, so
              the dashboard has no indexed backend to read from. The contracts
              are unaffected and remain live on Sepolia.
            </p>
          </div>
        )}

        {/* ============ ERROR ============ */}
        {error && (
          <div
            className={`notice ${
              networkStatus === "error" ? "notice-error" : "notice-warn"
            }`}
            role="alert"
          >
            <strong>{error.title}</strong>
            <p>{error.message}</p>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={retry}
              disabled={loadingSplits}
            >
              {loadingSplits ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}

        {/* ============ MAIN GRID ============ */}
        <div className="grid">
          <section className="panel" aria-labelledby="contracts-heading">
            <div className="panel-head">
              <h2 id="contracts-heading">Split contracts</h2>
              <p className="panel-sub">
                {isLiveData
                  ? "Read live from Sepolia."
                  : "Live contract reads are unavailable, so the current-state figures below come from the last successful read or are reconstructed from indexed events."}{" "}
                Each split divides a funded round equally among that
                round&rsquo;s participants.
              </p>
            </div>

            {loadingSplits && splits.length === 0 ? (
              <div className="empty">
                <div className="spinner" aria-hidden="true" />
                <p>Reading contracts from Sepolia…</p>
              </div>
            ) : splits.length === 0 ? (
              <div className="empty">
                <p>
                  {isNotConfigured
                    ? "No API configured — nothing to read."
                    : "No splits have been indexed for this factory."}
                </p>
              </div>
            ) : (
              <ul className="cards">
                {splits.map((split) => {
                  // Everything here is served by the API: prose, the
                  // deterministic lifecycle sentence, and wei as strings.
                  const description = split.description;
                  const explanation = split.lifecycleExplanation;
                  const balance = formatEth(BigInt(split.balanceWei));
                  const pool = formatEth(BigInt(split.roundPoolWei));

                  return (
                    <li className="card" key={split.address}>
                      <div className="card-head">
                        <h3 className="card-title">{split.title}</h3>
                        <div className="card-badges">
                          {split.badges.map((badge) => (
                            <StatusBadge
                              key={badge}
                              label={badge}
                              tone={BADGE_TONES[badge] || "live"}
                            />
                          ))}
                        </div>
                      </div>

                      {description ? (
                        <p className="card-desc">{description}</p>
                      ) : null}

                      <dl className="card-facts">
                        <div className="fact">
                          <dt>Round</dt>
                          <dd>{split.currentRound}</dd>
                        </div>
                        <div className="fact">
                          <dt>Participants this round</dt>
                          <dd>{split.currentParticipantCount}</dd>
                        </div>
                        <div className="fact">
                          <dt>Balance</dt>
                          <dd className={balance.dust ? "muted-tech" : ""}>
                            {balance.text}
                          </dd>
                        </div>
                        <div className="fact">
                          <dt>Unallocated pool</dt>
                          <dd className={pool.dust ? "muted-tech" : ""}>
                            {pool.zero ? "—" : pool.text}
                          </dd>
                        </div>
                      </dl>

                      <p className="card-explain">{explanation}</p>

                      <div className="card-foot">
                        <CopyAddress
                          address={split.address}
                          label={`${split.title} contract`}
                        />
                        <a
                          className="btn btn-link"
                          href={`${SEPOLIA_EXPLORER}/address/${split.address}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Etherscan
                          <span aria-hidden="true"> ↗</span>
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ============ CONTRACT INTELLIGENCE ============ */}
          <aside className="panel" aria-labelledby="intelligence-heading">
            <div className="panel-head">
              <h2 id="intelligence-heading">Contract Intelligence</h2>
              <p className="panel-sub">
                Read-only explanations generated from live contract state and
                Sepolia event history.
              </p>
            </div>

            <div className="questions">
              <h3 className="questions-title">Guided questions</h3>
              <ul className="question-list">
                {QUESTIONS.map((question) => (
                  <li key={question.id}>
                    <button
                      type="button"
                      className={
                        selectedQuestion === question.id
                          ? "question question-active"
                          : "question"
                      }
                      onClick={() => askQuestion(question)}
                      disabled={answerLoading || isNotConfigured}
                      aria-pressed={selectedQuestion === question.id}
                    >
                      <span className="question-label">{question.label}</span>
                      <span className="question-hint">{question.hint}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div
              className="answer-region"
              aria-live="polite"
              aria-busy={answerLoading}
            >
              {answerLoading && (
                <div className="answer-loading">
                  <div className="spinner" aria-hidden="true" />
                  <p>Reading contract state and event history...</p>
                </div>
              )}

              {!answerLoading && answerError && (
                <div className="notice notice-error" role="alert">
                  <strong>Could not generate an answer</strong>
                  <p>{answerError}</p>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      const question = QUESTIONS.find(
                        (candidate) => candidate.id === selectedQuestion
                      );

                      if (question) {
                        askQuestion(question);
                      }
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}

              {!answerLoading && !answerError && answer && (
                <article className="answer">
                  <header className="answer-head">
                    <h3 className="answer-title">{answer.title}</h3>
                    <span className={"badge badge-" + ANSWER_TONES[answer.status]}>
                      {ANSWER_STATUS_LABELS[answer.status]}
                    </span>
                  </header>

                  <p className="answer-summary">{answer.summary}</p>

                  {answer.note ? (
                    <p className="answer-note">{answer.note}</p>
                  ) : null}

                  {answer.facts.length > 0 ? (
                    <dl className="answer-facts">
                      {answer.facts.map((item, index) => (
                        <div
                          className="answer-fact"
                          key={item.label + "-" + index}
                        >
                          <dt>
                            <span className="answer-fact-label">
                              {item.label}
                            </span>
                            <span
                              className={"src src-" + item.source}
                              title={SOURCE_TITLES[item.source]}
                            >
                              {item.source}
                            </span>
                          </dt>
                          <dd>{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  {answer.evidence.length > 0 ? (
                    <div className="evidence">
                      <h4 className="evidence-title">
                        On-chain evidence ({answer.evidence.length})
                      </h4>
                      <ul className="evidence-list">
                        {answer.evidence.map((item, index) => (
                          <li key={item.etherscanUrl + "-" + index}>
                            <span className="evidence-label">{item.label}</span>
                            <span className="evidence-meta">
                              {item.blockNumber !== null ? (
                                <span className="evidence-block">
                                  block #{item.blockNumber}
                                </span>
                              ) : null}
                              {item.transactionHash ? (
                                <code className="mono evidence-hash">
                                  {abbreviateHash(item.transactionHash)}
                                </code>
                              ) : null}
                              <a
                                className="btn btn-link"
                                href={item.etherscanUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Etherscan
                                <span aria-hidden="true"> &#8599;</span>
                                <span className="sr-only">
                                  {" for " + item.label + " (opens in a new tab)"}
                                </span>
                              </a>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="evidence-empty">
                      No matching on-chain events were found in the queried block
                      range.
                    </p>
                  )}

                  <p className="answer-block">
                    Generated at block #
                    {answer.generatedAtBlock.toLocaleString()}
                  </p>
                </article>
              )}

              {!answerLoading && !answerError && !answer ? (
                <p className="answer-empty">
                  Choose a question above to generate a grounded explanation.
                </p>
              ) : null}
            </div>

            <p className="foot-note">
              No wallet connection &middot; No transaction execution &middot;
              Sepolia testnet only
            </p>
          </aside>
        </div>

        {/* ============ DEMO ENVIRONMENT ============ */}
        <section className="panel env" aria-labelledby="env-heading">
          <div className="env-head">
            <h2 id="env-heading">Demo environment</h2>
            <span className="testnet-flag">Testnet only</span>
          </div>

          <dl className="env-facts">
            <div className="fact">
              <dt>Network</dt>
              <dd>Sepolia</dd>
            </div>
            <div className="fact">
              <dt>Factory</dt>
              <dd>
                {factoryAddress ? (
                  <CopyAddress address={factoryAddress} label="factory" />
                ) : (
                  <span className="muted-tech">Unavailable</span>
                )}
              </dd>
            </div>
            <div className="fact">
              <dt>Contract version</dt>
              <dd>{factoryInfo ? `v${factoryInfo.version}` : "—"}</dd>
            </div>
            <div className="fact">
              <dt>Source</dt>
              <dd>
                {isLiveData
                  ? "Indexed events + live contract reads"
                  : "Indexed events (live contract reads unavailable)"}
              </dd>
            </div>
          </dl>

          <p className="env-disclaimer">
            Sepolia test ETH has no monetary value. Nothing here is a real
            payment, customer, or revenue record, and the contracts have not
            received a professional external audit.
          </p>

          {factoryAddress ? (
            <a
              className="btn btn-primary"
              href={`${SEPOLIA_EXPLORER}/address/${factoryAddress}`}
              target="_blank"
              rel="noreferrer"
            >
              View factory on Etherscan
              <span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </section>
      </main>

      <style jsx>{`
        .console {
          --ink: #111827;
          --ink-soft: #4b5563;
          --ink-mute: #6b7280;
          --line: #e5e7eb;
          --surface: #ffffff;
          --canvas: #f8fafc;
          --brand: #5b5bd6;
          --brand-deep: #6d28d9;
          --ok: #047857;
          --ok-bg: #ecfdf5;
          --warn: #b45309;
          --warn-bg: #fffbeb;
          --bad: #b91c1c;
          --bad-bg: #fef2f2;

          max-width: 1180px;
          margin: 0 auto;
          padding: 24px 20px 80px;
          color: var(--ink);
        }

        /* ---------- hero ---------- */
        .hero {
          background: linear-gradient(135deg, #5b5bd6 0%, #6d28d9 100%);
          color: #fff;
          border-radius: 16px;
          padding: 44px 32px;
          margin-bottom: 28px;
        }

        .hero-badges {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin: 0 0 20px;
          padding: 0;
          list-style: none;
        }

        .hero-badge {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 6.4px 13.6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.14);
          border: 1px solid rgba(255, 255, 255, 0.28);
        }

        .hero-badge-primary {
          background: rgba(255, 255, 255, 0.95);
          color: var(--brand-deep);
          border-color: transparent;
        }

        .hero-title {
          font-size: clamp(30.4px, 4vw, 44px);
          line-height: 1.15;
          font-weight: 700;
          margin: 0 0 13.6px;
          letter-spacing: -0.02em;
          color: #fff;
        }

        .hero-subtitle {
          font-size: clamp(16px, 1.6vw, 18.4px);
          line-height: 1.6;
          max-width: 62ch;
          margin: 0;
          color: rgba(255, 255, 255, 0.92);
        }

        /* ---------- tiles ---------- */
        .tiles {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-bottom: 28px;
        }

        /* ---------- notices ---------- */
        .notice {
          border: 1px dashed #9ca3af;
          background: #f3f4f6;
          color: #374151;
          border-radius: 12px;
          padding: 17.6px 20px;
          margin-bottom: 28px;
        }

        .notice strong {
          display: block;
          margin-bottom: 5.6px;
        }

        .notice p {
          margin: 0 0 12px;
          line-height: 1.6;
        }

        .notice p:last-child {
          margin-bottom: 0;
        }

        .notice-error {
          border: 1px solid #ef4444;
          background: var(--bad-bg);
          color: var(--bad);
        }

        .notice-warn {
          border: 1px solid #f59e0b;
          background: var(--warn-bg);
          color: var(--warn);
        }

        /* ---------- index freshness ---------- */
        .freshness {
          display: flex;
          flex-wrap: wrap;
          gap: 12px 24px;
          align-items: center;
          justify-content: space-between;
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 12px 16px;
          margin-bottom: 28px;
          background: var(--surface);
        }

        .freshness-main {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          font-size: 14px;
        }

        .freshness-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--ink-mute);
          flex: none;
        }

        .freshness-fresh {
          border-color: #a7f3d0;
          background: #f0fdf9;
        }

        .freshness-fresh .freshness-dot {
          background: var(--ok);
        }

        .freshness-stale {
          border-color: #fde68a;
          background: var(--warn-bg);
        }

        .freshness-stale .freshness-dot {
          background: var(--warn);
        }

        .freshness-error {
          border-color: #fecaca;
          background: var(--bad-bg);
        }

        .freshness-error .freshness-dot {
          background: var(--bad);
        }

        .freshness-detail {
          color: var(--ink-mute);
          font-size: 13px;
        }

        .freshness-facts {
          display: flex;
          flex-wrap: wrap;
          gap: 20px;
          margin: 0;
        }

        .freshness-facts dt {
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.7px;
          text-transform: uppercase;
          color: var(--ink-mute);
        }

        .freshness-facts dd {
          margin: 2px 0 0;
          font-size: 13.5px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }

        /* ---------- layout ---------- */
        .grid {
          display: grid;
          grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
          gap: 24px;
          align-items: start;
          margin-bottom: 24px;
        }

        .panel {
          background: var(--surface);
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 24px;
        }

        .panel-head {
          margin-bottom: 20px;
        }

        .panel h2 {
          font-size: 18.4px;
          font-weight: 700;
          margin: 0 0 5.6px;
          letter-spacing: -0.01em;
        }

        .panel-sub {
          margin: 0;
          font-size: 14.4px;
          line-height: 1.55;
          color: var(--ink-mute);
        }

        .empty {
          text-align: center;
          padding: 40px 16px;
          color: var(--ink-mute);
        }

        /* ---------- split cards ---------- */
        .cards {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .card {
          border: 1px solid var(--line);
          border-radius: 12px;
          padding: 18.4px 20px;
          background: var(--canvas);
        }

        .card-head {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 12px;
          align-items: baseline;
          justify-content: space-between;
          margin-bottom: 9.6px;
        }

        .card-title {
          font-size: 16.8px;
          font-weight: 700;
          margin: 0;
        }

        .card-badges {
          display: flex;
          flex-wrap: wrap;
          gap: 6.4px;
        }

        .card-desc {
          margin: 0 0 16px;
          font-size: 14.4px;
          line-height: 1.6;
          color: var(--ink-soft);
        }

        .card-facts,
        .env-facts {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 13.6px 16px;
          margin: 0 0 16px;
        }

        .fact dt {
          font-size: 11.52px;
          font-weight: 600;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: var(--ink-mute);
          margin-bottom: 3.2px;
        }

        .fact dd {
          margin: 0;
          font-size: 15.68px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }

        .card-explain {
          margin: 0 0 16px;
          font-size: 14.08px;
          line-height: 1.65;
          color: var(--ink-soft);
          border-left: 3px solid var(--line);
          padding-left: 13.6px;
        }

        .card-foot {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          align-items: center;
          justify-content: space-between;
          padding-top: 13.6px;
          border-top: 1px solid var(--line);
        }

        /* ---------- contract intelligence ---------- */
        .questions-title,
        .evidence-title,
        .answer-block {
          font-size: 11.2px;
          font-weight: 700;
          letter-spacing: 0.96px;
          text-transform: uppercase;
          color: var(--ink-mute);
          margin: 0 0 12px;
        }

        .question-list {
          list-style: none;
          margin: 0 0 20px;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .answer-region {
          min-height: 64px;
        }

        .answer-loading {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px 0;
          color: var(--ink-mute);
          font-size: 14px;
        }

        .answer-loading p {
          margin: 0;
        }

        .answer-empty,
        .evidence-empty {
          margin: 0;
          padding: 16px;
          border: 1px dashed var(--line);
          border-radius: 10px;
          font-size: 14px;
          line-height: 1.6;
          color: var(--ink-mute);
          background: var(--canvas);
        }

        .answer {
          border: 1px solid var(--line);
          border-radius: 12px;
          padding: 18px;
          background: var(--canvas);
        }

        .answer-head {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 12px;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 10px;
        }

        .answer-title {
          font-size: 16px;
          font-weight: 700;
          margin: 0;
        }

        .answer-summary {
          margin: 0 0 14px;
          font-size: 14.5px;
          line-height: 1.65;
          color: var(--ink);
        }

        .answer-note {
          margin: 0 0 14px;
          padding: 10px 12px;
          border-left: 3px solid #fcd34d;
          background: var(--warn-bg);
          color: var(--warn);
          font-size: 13px;
          line-height: 1.6;
          border-radius: 0 6px 6px 0;
        }

        .answer-facts {
          margin: 0 0 16px;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .answer-fact {
          border-top: 1px solid var(--line);
          padding-top: 10px;
        }

        .answer-fact:first-child {
          border-top: 0;
          padding-top: 0;
        }

        .answer-fact dt {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 3px;
        }

        .answer-fact-label {
          font-size: 11.5px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: var(--ink-mute);
        }

        .answer-fact dd {
          margin: 0;
          font-size: 14px;
          line-height: 1.6;
          color: var(--ink);
        }

        .evidence {
          border-top: 1px solid var(--line);
          padding-top: 14px;
        }

        .evidence-list {
          list-style: none;
          margin: 0 0 14px;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .evidence-list li {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .evidence-label {
          font-size: 13.5px;
          line-height: 1.5;
          color: var(--ink-soft);
        }

        .evidence-meta {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
        }

        .evidence-block {
          font-size: 12px;
          color: var(--ink-mute);
          font-variant-numeric: tabular-nums;
        }

        .answer-block {
          margin: 0;
          padding-top: 12px;
          border-top: 1px solid var(--line);
          font-variant-numeric: tabular-nums;
        }

        .foot-note {
          margin: 16px 0 0;
          font-size: 12.8px;
          color: var(--ink-mute);
        }

        /* ---------- demo environment ---------- */
        .env-head {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
        }

        .env-head h2 {
          font-size: 18.4px;
          font-weight: 700;
          margin: 0;
        }

        .testnet-flag {
          font-size: 11.52px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 5.6px 12px;
          border-radius: 999px;
          background: var(--warn-bg);
          color: var(--warn);
          border: 1px solid #fcd34d;
        }

        .env-disclaimer {
          font-size: 13.28px;
          line-height: 1.6;
          color: var(--ink-mute);
          margin: 0 0 20px;
          max-width: 70ch;
        }

        @media (max-width: 900px) {
          .grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }

        @media (max-width: 640px) {
          .console {
            padding: 16px 14.4px 56px;
          }

          .hero {
            padding: 30.4px 20px;
            border-radius: 12px;
          }

          .panel {
            padding: 18.4px;
          }

          .card-head {
            flex-direction: column;
            align-items: flex-start;
          }

          .card-foot {
            align-items: flex-start;
          }
        }
      `}</style>

      {/* Shared primitives used by the small components above. */}
      <style jsx global>{`
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }

        .tile {
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 16px 17.6px;
        }

        .tile-label {
          display: flex;
          align-items: center;
          gap: 6.4px;
          font-size: 11.52px;
          font-weight: 600;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: #6b7280;
          margin-bottom: 7.2px;
        }

        .tile-icon {
          font-size: 13.6px;
          line-height: 1;
        }

        .tile-value {
          font-size: 22.4px;
          font-weight: 700;
          line-height: 1.2;
          letter-spacing: -0.01em;
          font-variant-numeric: tabular-nums;
          color: #111827;
        }

        .tile-value.tone-ok {
          color: #047857;
        }

        .tile-value.tone-bad {
          color: #b91c1c;
        }

        .tile-value.tone-warn {
          color: #b45309;
        }

        .tile-value.tone-muted {
          color: #6b7280;
        }

        .tile-note {
          margin-top: 4.8px;
          font-size: 12.48px;
          color: #6b7280;
        }

        .badge {
          display: inline-block;
          font-size: 11.2px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 4.48px 9.6px;
          border-radius: 6px;
          white-space: nowrap;
        }

        .badge-live {
          background: #eef2ff;
          color: #3730a3;
          border: 1px solid #c7d2fe;
        }

        .badge-done {
          background: #ecfdf5;
          color: #047857;
          border: 1px solid #a7f3d0;
        }

        .badge-warn {
          background: #fffbeb;
          color: #b45309;
          border: 1px solid #fde68a;
        }

        .mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 13.6px;
          color: #374151;
          background: #f3f4f6;
          padding: 3.2px 7.2px;
          border-radius: 5px;
        }

        .muted-tech {
          color: #6b7280;
          font-weight: 500;
          font-size: 14.4px;
        }

        .copy-wrap {
          display: inline-flex;
          align-items: center;
          gap: 7.2px;
        }

        .copy-btn,
        .btn {
          font: inherit;
          cursor: pointer;
          border-radius: 7px;
          transition: background-color 0.15s ease, color 0.15s ease,
            border-color 0.15s ease;
        }

        .copy-btn {
          font-size: 12px;
          font-weight: 600;
          padding: 4px 8.8px;
          background: #fff;
          color: #4b5563;
          border: 1px solid #d1d5db;
        }

        .copy-btn:hover {
          background: #f3f4f6;
          color: #111827;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          gap: 4.8px;
          font-size: 13.6px;
          font-weight: 600;
          text-decoration: none;
          border: 1px solid transparent;
          padding: 7.2px 14.4px;
        }

        .btn-link {
          padding: 4.8px 0;
          color: #5b5bd6;
          background: none;
        }

        .btn-link:hover {
          color: #4338ca;
          text-decoration: underline;
        }

        .btn-primary {
          background: #5b5bd6;
          color: #fff;
        }

        .btn-primary:hover {
          background: #4c4cc4;
          color: #fff;
        }

        .btn-ghost {
          background: transparent;
          color: inherit;
          border-color: currentColor;
        }

        .btn-ghost:disabled {
          opacity: 0.6;
          cursor: default;
        }

        .question {
          display: block;
          width: 100%;
          text-align: left;
          padding: 11px 13px;
          border: 1px solid #e5e7eb;
          border-radius: 9px;
          background: #fff;
          cursor: pointer;
        }

        .question:hover:not(:disabled) {
          border-color: #a5b4fc;
          background: #f5f5ff;
        }

        .question:disabled {
          opacity: 0.55;
          cursor: default;
        }

        .question-active {
          border-color: #5b5bd6;
          background: #eef2ff;
        }

        .question-label {
          display: block;
          font-size: 14px;
          font-weight: 600;
          color: #111827;
          margin-bottom: 2px;
        }

        .question-hint {
          display: block;
          font-size: 12px;
          line-height: 1.45;
          color: #6b7280;
        }

        .src {
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid transparent;
        }

        .src-read {
          background: #eef2ff;
          color: #3730a3;
          border-color: #c7d2fe;
        }

        .src-event {
          background: #ecfdf5;
          color: #047857;
          border-color: #a7f3d0;
        }

        .src-derived {
          background: #f3f4f6;
          color: #4b5563;
          border-color: #d1d5db;
        }

        .evidence-hash {
          font-size: 12px;
        }

        .question:focus-visible,
        .copy-btn:focus-visible,
        .btn:focus-visible,
        .console a:focus-visible {
          outline: 2px solid #4338ca;
          outline-offset: 2px;
        }
      `}</style>
    </>
  );
};

export default Web3Console;
