// backend/src/api/snapshot.js
//
// The dashboard snapshot, built once and shared.
//
// Before: `/splits` and `/summary` each called loadSnapshot() independently, so
// one dashboard refresh performed the same live contract reads twice, plus a
// third `eth_blockNumber` from `/health` — 45 JSON-RPC operations every 15
// seconds from a single browser tab.
//
// After: one cached snapshot per TTL, one in-flight refresh shared by every
// concurrent caller, and a separately cached chain head so `/health` does not
// pay for a chain read on every poll.
//
// ---------------------------------------------------------------------------
// Current state is never invented.
//
// Three provenances, tracked per split, because a partial failure is the common
// case and describing it as either total success or total failure would be a
// lie:
//
//   live             read from the contract during this refresh
//   last-known-good  read successfully earlier and not refreshed since; real
//                    values, but not current — kept for at most
//                    API_SNAPSHOT_MAX_STALE_SECONDS
//   derived          reconstructed from indexed events; no read involved
//
// The failure that motivated this: a refresh whose database queries succeed but
// whose contract reads fail still produces a snapshot, and that snapshot used to
// overwrite the good one in the cache with zeroes — so a funded contract would
// report a balance of 0 ETH, cited as a contract read. Keeping the last good
// per-split reads separately from the cached snapshot is what prevents it.
//
// Freshness reported to callers:
//
//   fresh      built by this request, every split read live
//   cached     served from memory inside the TTL, every split read live
//   degraded   built now, but at least one split is not live
//   stale      a refresh failed and the previous snapshot is being served
//
// Participant addresses are not part of a snapshot and are not introduced here;
// caching changes when the same data is served, never what is in it.

const { createCachedResource } = require("../util/cached-resource");
const { describeRpcError } = require("../util/redact");
const { withTimeout } = require("../util/timeout");
const { buildSnapshotFromIndex } = require("../indexer/projection");

/** A snapshot whose live reads did not all succeed is degraded, however new. */
const freshnessFor = (state, live) => {
  if (state === "fresh" || state === "cached") {
    return live ? state : "degraded";
  }

  return state;
};

/** Coarse label for where the snapshot's current-state figures came from. */
const sourceFor = (coverage) => {
  if (coverage.total === 0) {
    return "none";
  }

  if (coverage.live === coverage.total) {
    return "live";
  }

  if (coverage.live > 0) {
    return "mixed";
  }

  return coverage.lastKnownGood === coverage.total ? "last-known-good" : "index";
};

const createSnapshotService = ({ runtime, logger = console }) => {
  const { config } = runtime;
  const cooldownMs = config.api.rpcErrorCooldownSeconds * 1000;
  const maxStaleMs = config.api.snapshotMaxStaleSeconds * 1000;

  /**
   * The last contract read that succeeded, per split.
   *
   * Deliberately held outside the snapshot cache. A refresh that fails its
   * reads still replaces the cached snapshot; without this, the good values
   * would be replaced along with it.
   */
  const lastGoodReads = new Map();

  /**
   * Latest chain block, cached.
   *
   * Shared by `/health` and the snapshot builder. On failure the previous value
   * is served as stale rather than re-requested from a provider that is already
   * refusing, which is what keeps `/health` fast during an outage.
   */
  const chainHead = createCachedResource({
    name: "chain-head",
    ttlMs: config.api.chainHeadTtlSeconds * 1000,
    maxStaleMs,
    cooldownMs,
    load: async () => {
      if (!runtime.reader) {
        throw new Error("No RPC configured");
      }

      // Bounded here, not only in the reader. `/health` promises to answer
      // inside API_HEALTH_TIMEOUT_MS, and that promise must not depend on how
      // the reader happened to be constructed.
      return withTimeout(
        runtime.reader.getBlockNumber(),
        config.api.healthTimeoutMs,
        "chain head read"
      );
    },
  });

  /** Attempts one contract read per split. Never throws; reports per split. */
  const attemptLiveReads = async (splits) => {
    if (!runtime.reader) {
      return new Map(
        splits.map((split) => [
          split.address,
          { ok: false, error: new Error("No RPC configured") },
        ])
      );
    }

    const results = await Promise.all(
      splits.map(async (split) => {
        try {
          const reads = await withTimeout(
            runtime.reader.readSplitState(split.address),
            config.rpc.timeoutMs,
            `live state ${split.address}`
          );

          return [split.address, { ok: true, reads }];
        } catch (error) {
          return [split.address, { ok: false, error }];
        }
      })
    );

    return new Map(results);
  };

  /**
   * Turns raw read results into the provenance-tagged map the projection wants,
   * and produces one honest warning per split that is not live.
   */
  const resolveLiveState = (splits, attempts, headBlock, now) => {
    const liveState = new Map();
    const warnings = [];
    const coverage = {
      live: 0,
      lastKnownGood: 0,
      derived: 0,
      total: splits.length,
    };

    splits.forEach((split) => {
      const attempt = attempts.get(split.address);

      if (attempt && attempt.ok) {
        lastGoodReads.set(split.address, {
          reads: attempt.reads,
          at: now,
          readAtBlock: headBlock,
        });

        liveState.set(split.address, {
          reads: attempt.reads,
          source: "live",
          readAtBlock: headBlock,
        });

        coverage.live += 1;
        return;
      }

      const described = describeRpcError(attempt ? attempt.error : null);

      // Structured and redacted: host, status and category, never the URL.
      logger.warn(
        { rpc: described, split: split.address },
        "live split state unavailable"
      );

      const remembered = lastGoodReads.get(split.address);
      const withinWindow =
        remembered && maxStaleMs > 0 && now - remembered.at <= maxStaleMs;

      if (withinWindow) {
        liveState.set(split.address, {
          reads: remembered.reads,
          source: "last-known-good",
          readAtBlock: remembered.readAtBlock,
        });

        coverage.lastKnownGood += 1;

        warnings.push(
          `Current state for ${split.title} could not be refreshed ` +
            `(${described.category}); showing the last successful read` +
            (remembered.readAtBlock
              ? ` from block ${remembered.readAtBlock}.`
              : ".") +
            " These are not current live-chain values."
        );

        return;
      }

      if (remembered) {
        // Older than the stale window: drop it rather than keep serving it.
        lastGoodReads.delete(split.address);
      }

      coverage.derived += 1;

      warnings.push(
        `Current state for ${split.title} could not be read from the RPC ` +
          `(${described.category}); the figures shown are reconstructed from ` +
          "indexed events, not read from the contract."
      );
    });

    return { liveState, warnings, coverage };
  };

  /**
   * Builds one snapshot.
   *
   * The chain head and the live reads are requested concurrently, so the whole
   * build is bounded by the slowest single RPC call rather than their sum.
   */
  const buildSnapshot = async () => {
    const { prisma } = runtime;

    const factory = await prisma.factory.findUnique({
      where: {
        chainId_address: {
          chainId: config.chainId,
          address: String(config.factoryAddress).toLowerCase(),
        },
      },
      include: { splits: true },
    });

    const splits = factory ? factory.splits : [];

    const [headResult, attempts] = await Promise.all([
      chainHead.get(),
      attemptLiveReads(splits),
    ]);

    // A stale cached height is not a chain head. Reporting one as the other is
    // what let indexerLagBlocks read zero during an outage.
    const chainHeadBlock =
      headResult.state === "fresh" || headResult.state === "cached"
        ? headResult.value
        : null;

    const { liveState, warnings, coverage } = resolveLiveState(
      splits,
      attempts,
      chainHeadBlock,
      Date.now()
    );

    if (chainHeadBlock === null) {
      warnings.push("The latest chain block could not be read.");
    }

    // The block the snapshot describes. With no chain head this falls back to
    // the indexer cursor, which is a real block — but it is the INDEXED block,
    // and `generatedAtBlockIsChainHead` says so rather than leaving callers to
    // assume otherwise.
    let generatedAtBlock = chainHeadBlock || 0;
    let generatedAtBlockIsChainHead = chainHeadBlock !== null;

    if (!generatedAtBlock) {
      const checkpoint = factory
        ? await prisma.indexerCheckpoint.findFirst({
            where: { factoryId: factory.id },
          })
        : null;

      generatedAtBlock = checkpoint ? checkpoint.lastIndexedBlock : 0;
      generatedAtBlockIsChainHead = false;
    }

    const snapshot = await buildSnapshotFromIndex({
      prisma,
      config,
      liveState,
      generatedAtBlock,
      historyComplete: true,
    });

    snapshot.warnings = [...snapshot.warnings, ...warnings];

    return {
      snapshot,
      coverage,
      live: coverage.total > 0 && coverage.live === coverage.total,
      chainHead: {
        block: chainHeadBlock,
        available: chainHeadBlock !== null,
        ageSeconds:
          headResult.ageMs === null || headResult.ageMs === undefined
            ? null
            : Math.round(headResult.ageMs / 1000),
      },
      generatedAtBlockIsChainHead,
      builtAt: Date.now(),
    };
  };

  const snapshots = createCachedResource({
    name: "snapshot",
    ttlMs: config.api.snapshotTtlSeconds * 1000,
    maxStaleMs,
    cooldownMs,
    load: buildSnapshot,
  });

  /**
   * The snapshot plus the metadata a caller needs to describe it truthfully.
   *
   * @returns {Promise<{snapshot: Object, freshness: Object, chainHead: Object}>}
   */
  const getSnapshot = async (options = {}) => {
    const result = await snapshots.get(options);

    if (!result.value) {
      // Only a database failure gets this far: a failed RPC still yields a
      // snapshot built from the index. Rethrown untouched so the error handler
      // keeps classifying it as an internal error and keeps its detail out of
      // the response body.
      throw result.error || new Error("Snapshot unavailable");
    }

    const {
      snapshot,
      live,
      coverage,
      chainHead: head,
      generatedAtBlockIsChainHead,
    } = result.value;

    const state = freshnessFor(result.state, live);
    const ageSeconds = Math.round((result.ageMs || 0) / 1000);

    const freshness = {
      state,
      // "live" only when every split was read from the chain during this
      // refresh. "mixed" when some were. Never "live" for a partial success.
      source: sourceFor(coverage),
      currentState: coverage,
      generatedAt: new Date(result.loadedAt).toISOString(),
      ageSeconds,
      ttlSeconds: config.api.snapshotTtlSeconds,
      servedFromCache: result.state !== "fresh",
      stale: state === "stale",
      degraded: state === "degraded" || state === "stale" || !live,
      generatedAtBlockIsChainHead: Boolean(generatedAtBlockIsChainHead),
    };

    const warnings = [...snapshot.warnings];

    if (state === "stale") {
      warnings.push(
        `Live refresh failed; showing the last successful snapshot from ` +
          `${ageSeconds}s ago. These are not current live-chain values.`
      );
    }

    return {
      snapshot: { ...snapshot, warnings },
      freshness,
      chainHead: head,
    };
  };

  /** Latest chain block for `/health`. Never throws, never blocks on cooldown. */
  const getChainHead = async () => {
    if (!runtime.reader) {
      return { value: null, state: "not-configured", ageMs: null, error: null };
    }

    return chainHead.get();
  };

  /** Non-sensitive counters for `/health` and for tests. */
  const stats = () => ({
    snapshot: snapshots.stats(),
    chainHead: chainHead.stats(),
    lastGoodReads: lastGoodReads.size,
  });

  return {
    getSnapshot,
    getChainHead,
    peekSnapshot: snapshots.peek,
    stats,
    clear: () => {
      snapshots.clear();
      chainHead.clear();
      lastGoodReads.clear();
    },
  };
};

module.exports = { createSnapshotService, freshnessFor, sourceFor };
