// backend/src/api/routes.js
//
// Every public route. All GET, all read-only, all schema-validated.
//
// Historical facts are served from the index; current state is read live from
// the chain and merged. Participant addresses never appear in a response.

const path = require("path");

const LIB = path.join(__dirname, "..", "..", "..", "lib", "contract-intelligence");

const { analyze, describeLifecycle } = require(path.join(LIB, "analysis"));
const { QUESTIONS } = require(path.join(LIB, "constants"));
const { summarizeParticipation } = require("../indexer/projection");
const { MANIFEST_PATH } = require("../config");
const { withTimeout } = require("../util/timeout");
const { describeRpcError } = require("../util/redact");

/**
 * Static scenario prose, the manifest's only remaining role.
 *
 * Serving it from the API keeps the frontend a pure API client rather than
 * re-importing the deployment manifest for one string.
 */
const readDescriptions = () => {
  try {
    const manifest = JSON.parse(require("fs").readFileSync(MANIFEST_PATH, "utf8"));
    return new Map(
      (manifest.splits || []).map((split) => [
        String(split.splitAddress).toLowerCase(),
        split.description,
      ])
    );
  } catch {
    return new Map();
  }
};

const DESCRIPTIONS = readDescriptions();

/**
 * Adds the two presentation fields the browser can no longer derive itself:
 * static prose, and the deterministic lifecycle sentence (which needs BigInt
 * arithmetic the JSON payload cannot carry).
 */
const decorateSplit = (split) => ({
  ...split,
  description: DESCRIPTIONS.get(split.address.toLowerCase()) || null,
  lifecycleExplanation: describeLifecycle(split),
});

const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    type: { type: "string" },
    blockNumber: { type: ["integer", "null"] },
    transactionHash: { type: ["string", "null"] },
    etherscanUrl: { type: "string" },
  },
};

const SPLIT_SCHEMA = {
  type: "object",
  properties: {
    address: { type: "string" },
    title: { type: "string" },
    version: { type: "string" },
    currentRound: { type: "integer" },
    currentParticipantCount: { type: "integer" },
    balanceWei: { type: "string" },
    roundPoolWei: { type: "string" },
    totalClaimableWei: { type: "string" },
    createdAtBlock: { type: ["integer", "null"] },
    creationTxHash: { type: ["string", "null"] },
    withdrawalCount: { type: "integer" },
    withdrawnTotalWei: { type: "string" },
    outstandingClaimCount: { type: "integer" },
    lifecycleState: { type: "string" },
    // Where the current-state figures came from: "live", "last-known-good" or
    // "derived". Part of the contract, not a debugging extra — a client cannot
    // describe these numbers honestly without it.
    currentStateSource: { type: "string" },
    currentStateAtBlock: { type: ["integer", "null"] },
    description: { type: ["string", "null"] },
    lifecycleExplanation: { type: "string" },
    badges: { type: "array", items: { type: "string" } },
    historyComplete: { type: "boolean" },
    rounds: {
      type: "array",
      items: {
        type: "object",
        properties: {
          round: { type: "integer" },
          joinCount: { type: "integer" },
          fundedWei: { type: "string" },
          finalized: { type: "boolean" },
          totalDistributedWei: { type: "string" },
          amountPerParticipantWei: { type: "string" },
          finalizedParticipantCount: { type: "integer" },
          remainderWei: { type: "string" },
          evidence: { type: "array", items: EVIDENCE_SCHEMA },
        },
      },
    },
    evidence: { type: "array", items: EVIDENCE_SCHEMA },
  },
};

/** Freshness metadata attached to every snapshot-derived response. */
const FRESHNESS_SCHEMA = {
  type: "object",
  properties: {
    state: { type: "string" },
    source: { type: "string" },
    // Per-split provenance counts, so a partial failure is visible rather than
    // averaged away by the coarse `source` label.
    currentState: {
      type: "object",
      properties: {
        live: { type: "integer" },
        lastKnownGood: { type: "integer" },
        derived: { type: "integer" },
        total: { type: "integer" },
      },
    },
    generatedAt: { type: "string" },
    ageSeconds: { type: "integer" },
    ttlSeconds: { type: "integer" },
    servedFromCache: { type: "boolean" },
    stale: { type: "boolean" },
    degraded: { type: "boolean" },
    // False when generatedAtBlock is the indexer cursor rather than the head.
    generatedAtBlockIsChainHead: { type: "boolean" },
  },
};

/**
 * The shared snapshot.
 *
 * Every route that needs one goes through the cache in src/api/snapshot.js, so
 * `/splits`, `/summary`, `/dashboard` and an intelligence answer arriving
 * together perform one refresh between them instead of one each.
 */
const loadSnapshot = async (app) => {
  const { snapshot } = await app.snapshots.getSnapshot();
  return snapshot;
};

async function registerRoutes(app) {
  const { runtime } = app;
  const { prisma, config } = runtime;

  // ---------- health ----------
  //
  // Must answer quickly whatever else is broken, because it is the only thing
  // an external monitor looks at. Both the database ping and the chain read are
  // bounded by API_HEALTH_TIMEOUT_MS and run concurrently, and the chain read
  // comes from the shared cache — so a provider that is down or throttling does
  // not cost a fresh timeout on every poll.
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              database: { type: "string" },
              rpc: { type: "string" },
              chainId: { type: "integer" },
              factoryAddress: { type: "string" },
              latestIndexedBlock: { type: ["integer", "null"] },
              latestChainBlock: { type: ["integer", "null"] },
              chainBlockAgeSeconds: { type: ["number", "null"] },
              indexerLagBlocks: { type: ["integer", "null"] },
              lastSuccessfulSync: { type: ["string", "null"] },
              secondsSinceSync: { type: ["number", "null"] },
              stale: { type: "boolean" },
              servingCachedData: { type: "boolean" },
              servingStaleData: { type: "boolean" },
              snapshotState: { type: "string" },
              snapshotAgeSeconds: { type: ["integer", "null"] },
              uptimeSeconds: { type: "number" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const timeoutMs = config.api.healthTimeoutMs;

      const [databaseResult, headResult] = await Promise.all([
        (async () => {
          try {
            await withTimeout(
              prisma.$queryRaw`SELECT 1`,
              timeoutMs,
              "health database ping"
            );

            return { up: true };
          } catch (error) {
            request.log.error({ err: error }, "health: database unreachable");
            return { up: false };
          }
        })(),
        app.snapshots.getChainHead(),
      ]);

      let database = databaseResult.up ? "up" : "down";
      let status = databaseResult.up ? "ok" : "error";

      let latestIndexedBlock = null;
      let lastSuccessfulSync = null;

      if (database === "up") {
        try {
          const checkpoint = await withTimeout(
            prisma.indexerCheckpoint.findFirst({
              where: { chainId: config.chainId },
              orderBy: { updatedAt: "desc" },
            }),
            timeoutMs,
            "health checkpoint read"
          );

          if (checkpoint) {
            latestIndexedBlock = checkpoint.lastIndexedBlock;
            lastSuccessfulSync = checkpoint.lastSyncCompletedAt
              ? checkpoint.lastSyncCompletedAt.toISOString()
              : null;
          }
        } catch (error) {
          request.log.error({ err: error }, "health: checkpoint unreadable");
          database = "down";
          status = "error";
        }
      }

      // "up" only when a live read succeeded. A cached value that is being
      // served because the provider is failing is reported as degraded.
      const rpc = {
        fresh: "up",
        cached: "up",
        stale: "degraded",
        unavailable: "down",
        "not-configured": "not-configured",
      }[headResult.state] || "unknown";

      if (rpc === "degraded" || rpc === "down") {
        if (headResult.error) {
          request.log.warn(
            { rpc: describeRpcError(headResult.error) },
            "health: RPC degraded"
          );
        }

        if (status === "ok") {
          status = "degraded";
        }
      }

      const latestChainBlock =
        headResult.value === undefined ? null : headResult.value;
      const chainBlockAgeSeconds =
        headResult.ageMs === null || headResult.ageMs === undefined
          ? null
          : Math.round(headResult.ageMs / 1000);

      const indexerLagBlocks =
        latestChainBlock !== null && latestIndexedBlock !== null
          ? Math.max(0, latestChainBlock - latestIndexedBlock)
          : null;

      const secondsSinceSync = lastSuccessfulSync
        ? (Date.now() - new Date(lastSuccessfulSync).getTime()) / 1000
        : null;

      const stale =
        secondsSinceSync === null ||
        secondsSinceSync > config.api.staleAfterSeconds;

      if (status === "ok" && stale) {
        status = "degraded";
      }

      // Reported without touching the RPC: this is what the API is currently
      // handing to visitors, not a fresh probe.
      const snapshot = app.snapshots.peekSnapshot();

      reply.status(database === "down" ? 503 : 200).send({
        status,
        database,
        rpc,
        chainId: config.chainId,
        factoryAddress: String(config.factoryAddress).toLowerCase(),
        latestIndexedBlock,
        latestChainBlock,
        chainBlockAgeSeconds,
        indexerLagBlocks,
        lastSuccessfulSync,
        secondsSinceSync,
        stale,
        servingCachedData: snapshot.state === "cached" || snapshot.state === "stale",
        servingStaleData: snapshot.state === "stale",
        snapshotState: snapshot.state,
        snapshotAgeSeconds:
          snapshot.ageMs === null ? null : Math.round(snapshot.ageMs / 1000),
        uptimeSeconds: Math.round(process.uptime()),
      });
    }
  );

  /** Summary body. Shared by `/summary` and the combined dashboard payload. */
  const buildSummary = (snapshot) => ({
    factory: {
      address: snapshot.address,
      version: snapshot.version,
      deploymentBlock: snapshot.deploymentBlock,
      deployedSplitCount: snapshot.deployedSplitCount,
    },
    chainId: config.chainId,
    generatedAtBlock: snapshot.generatedAtBlock,
    totalHeldWei: snapshot.splits.reduce(
      (sum, split) => sum + split.balanceWei,
      0n
    ),
    participation: summarizeParticipation(snapshot),
    warnings: snapshot.warnings,
  });

  // ---------- summary ----------
  app.get("/api/v1/web3/summary", async (request, reply) => {
    const { snapshot, freshness } = await app.snapshots.getSnapshot();

    reply.send(app.bigintSafe({ ...buildSummary(snapshot), freshness }));
  });

  // ---------- splits ----------
  app.get(
    "/api/v1/web3/splits",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              generatedAtBlock: { type: "integer" },
              splits: { type: "array", items: SPLIT_SCHEMA },
              warnings: { type: "array", items: { type: "string" } },
              freshness: FRESHNESS_SCHEMA,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { snapshot, freshness } = await app.snapshots.getSnapshot();

      reply.send(
        app.bigintSafe({
          generatedAtBlock: snapshot.generatedAtBlock,
          splits: snapshot.splits.map(decorateSplit),
          warnings: snapshot.warnings,
          freshness,
        })
      );
    }
  );

  app.get(
    "/api/v1/web3/splits/:address",
    {
      schema: {
        params: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { snapshot, freshness } = await app.snapshots.getSnapshot();
      const wanted = request.params.address.toLowerCase();
      const split = snapshot.splits.find(
        (candidate) => candidate.address.toLowerCase() === wanted
      );

      if (!split) {
        reply.status(404).send({
          error: "Not Found",
          message: "No split with that address on the active demo factory.",
          requestId: request.id,
          statusCode: 404,
        });
        return;
      }

      reply.send(
        app.bigintSafe({
          generatedAtBlock: snapshot.generatedAtBlock,
          split: decorateSplit(split),
          freshness,
        })
      );
    }
  );

  // ---------- dashboard ----------
  //
  // Everything the console homepage renders, from one snapshot, in one request.
  //
  // The page used to fetch `/health`, `/splits` and `/summary` concurrently
  // every 15 seconds; because each rebuilt its own snapshot, one refresh cost
  // about 45 JSON-RPC operations — roughly 180 a minute for a continuously open,
  // visible tab. This route answers all three from the same
  // cached snapshot, so the cost is one refresh per TTL no matter how many tabs
  // are open. `/health`, `/splits` and `/summary` remain, unchanged in shape,
  // for monitors and for any client built before this endpoint existed.
  app.get(
    "/api/v1/web3/dashboard",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              generatedAtBlock: { type: "integer" },
              splits: { type: "array", items: SPLIT_SCHEMA },
              warnings: { type: "array", items: { type: "string" } },
              freshness: FRESHNESS_SCHEMA,
              summary: {
                type: "object",
                properties: {
                  factory: {
                    type: "object",
                    properties: {
                      address: { type: "string" },
                      version: { type: "string" },
                      deploymentBlock: { type: ["integer", "null"] },
                      deployedSplitCount: { type: "integer" },
                    },
                  },
                  chainId: { type: "integer" },
                  generatedAtBlock: { type: "integer" },
                  totalHeldWei: { type: "string" },
                  participation: {
                    type: "object",
                    properties: {
                      totalJoinEvents: { type: "integer" },
                      activeInOpenRounds: { type: "integer" },
                      joinsInCompletedRounds: { type: "integer" },
                      splitCount: { type: "integer" },
                      completedSplitTitles: {
                        type: "array",
                        items: { type: "string" },
                      },
                      sentence: { type: "string" },
                    },
                  },
                  warnings: { type: "array", items: { type: "string" } },
                },
              },
              health: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  database: { type: "string" },
                  rpc: { type: "string" },
                  latestIndexedBlock: { type: ["integer", "null"] },
                  latestChainBlock: { type: ["integer", "null"] },
                  chainBlockAgeSeconds: { type: ["number", "null"] },
                  indexerLagBlocks: { type: ["integer", "null"] },
                  lastSuccessfulSync: { type: ["string", "null"] },
                  secondsSinceSync: { type: ["number", "null"] },
                  stale: { type: "boolean" },
                  servingCachedData: { type: "boolean" },
                  servingStaleData: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { snapshot, freshness, chainHead } =
        await app.snapshots.getSnapshot();

      // Index freshness for the banner. Read from the database only: the chain
      // head is whatever the snapshot refresh already established, so this adds
      // no RPC traffic of its own.
      let latestIndexedBlock = null;
      let lastSuccessfulSync = null;
      let database = "up";

      try {
        const checkpoint = await withTimeout(
          prisma.indexerCheckpoint.findFirst({
            where: { chainId: config.chainId },
            orderBy: { updatedAt: "desc" },
          }),
          config.api.healthTimeoutMs,
          "dashboard checkpoint read"
        );

        if (checkpoint) {
          latestIndexedBlock = checkpoint.lastIndexedBlock;
          lastSuccessfulSync = checkpoint.lastSyncCompletedAt
            ? checkpoint.lastSyncCompletedAt.toISOString()
            : null;
        }
      } catch (error) {
        request.log.warn({ err: error }, "dashboard: checkpoint unreadable");
        database = "degraded";
      }

      // The actual chain head, carried separately from the snapshot's
      // generatedAtBlock. Those two diverge exactly when it matters: with the
      // RPC down, generatedAtBlock falls back to the indexer cursor, and using
      // it here reported the cursor as the chain head and computed a lag of
      // zero — the API confidently claiming to be perfectly in sync precisely
      // when it could not see the chain at all.
      const latestChainBlock = chainHead.available ? chainHead.block : null;

      const secondsSinceSync = lastSuccessfulSync
        ? (Date.now() - new Date(lastSuccessfulSync).getTime()) / 1000
        : null;
      const indexStale =
        secondsSinceSync === null ||
        secondsSinceSync > config.api.staleAfterSeconds;

      // A successful eth_blockNumber does not prove contract reads work, so the
      // RPC verdict here follows the snapshot's own provenance, not the head.
      const rpc = freshness.source === "live" ? "up" : "degraded";

      reply.send(
        app.bigintSafe({
          generatedAtBlock: snapshot.generatedAtBlock,
          splits: snapshot.splits.map(decorateSplit),
          warnings: snapshot.warnings,
          freshness,
          summary: buildSummary(snapshot),
          health: {
            status:
              database !== "up" || indexStale || rpc !== "up" ? "degraded" : "ok",
            database,
            rpc,
            latestIndexedBlock,
            latestChainBlock,
            chainBlockAgeSeconds: chainHead.ageSeconds,
            // Null, not zero, when there is no chain head to compare against.
            indexerLagBlocks:
              latestChainBlock !== null && latestIndexedBlock !== null
                ? Math.max(0, latestChainBlock - latestIndexedBlock)
                : null,
            lastSuccessfulSync,
            secondsSinceSync,
            stale: indexStale,
            servingCachedData: freshness.servedFromCache,
            servingStaleData: freshness.stale,
          },
        })
      );
    }
  );

  // ---------- activity ----------
  app.get(
    "/api/v1/web3/activity",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            eventName: { type: "string", maxLength: 48 },
          },
        },
      },
    },
    async (request, reply) => {
      const { limit, eventName } = request.query;

       const factory = await prisma.factory.findUnique({
        where: {
          chainId_address: {
            chainId: config.chainId,
            address: config.factoryAddress.toLowerCase(),
          },
        },
        select: { id: true },
      });

      const where = {
        chainId: config.chainId,
        OR: [
          { address: config.factoryAddress.toLowerCase() },
          ...(factory
            ? [{ split: { is: { factoryId: factory.id } } }]
            : []),
        ],
      };

      if (eventName) {
        where.eventName = eventName;
      }

      const rows = await prisma.chainEvent.findMany({
        where,
        orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
        take: limit,
        include: { split: { select: { title: true, address: true } } },
      });

      // Only non-identifying argument fields are exposed. `participant` and
      // `manager` are dropped so no address reaches a dashboard response.
      const PUBLIC_ARGS = [
        "round",
        "participantCount",
        "amount",
        "roundPoolTotal",
        "totalDistributed",
        "amountPerParticipant",
        "remainderRemaining",
        "remainingClaimable",
        "title",
        "index",
      ];

      reply.send({
        count: rows.length,
        events: rows.map((row) => {
          const args = {};

          PUBLIC_ARGS.forEach((key) => {
            if (row.args && row.args[key] !== undefined) {
              args[key] = String(row.args[key]);
            }
          });

          return {
            eventName: row.eventName,
            splitTitle: row.split ? row.split.title : null,
            splitAddress: row.split ? row.split.address : null,
            blockNumber: row.blockNumber,
            transactionHash: row.transactionHash,
            logIndex: row.logIndex,
            blockTimestamp: row.blockTimestamp
              ? row.blockTimestamp.toISOString()
              : null,
            round: row.round,
            args,
          };
        }),
      });
    }
  );

  // ---------- intelligence ----------
  app.get(
    "/api/v1/web3/intelligence/:questionId",
    {
      schema: {
        params: {
          type: "object",
          required: ["questionId"],
          properties: {
            questionId: {
              type: "string",
              enum: QUESTIONS.map((question) => question.id),
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { questionId } = request.params;
      const question = QUESTIONS.find((entry) => entry.id === questionId);
      const snapshot = await loadSnapshot(app);

      let splitAddress;

      if (question.splitKey) {
        const target = await prisma.split.findFirst({
          where: {
            chainId: config.chainId,
            title: { equals: "Creator Revenue Share" },
          },
        });

        splitAddress = target
          ? target.address
          : snapshot.splits.length
          ? snapshot.splits[0].address
          : undefined;
      }

      const answer = analyze(questionId, snapshot, { splitAddress });

      reply.send(app.bigintSafe(answer));
    }
  );

  // ---------- questions ----------
  app.get("/api/v1/web3/questions", async (request, reply) => {
    reply.send({
      questions: QUESTIONS.map(({ id, label, hint }) => ({ id, label, hint })),
    });
  });
}

module.exports = { registerRoutes, loadSnapshot };
