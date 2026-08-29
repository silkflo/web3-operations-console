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
const {
  buildSnapshotFromIndex,
  summarizeParticipation,
} = require("../indexer/projection");
const { MANIFEST_PATH } = require("../config");

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

/** Live current state for every indexed split, tolerating RPC failure. */
const readLiveState = async (runtime, splits) => {
  const liveState = new Map();
  const warnings = [];

  if (!runtime.reader) {
    warnings.push("No RPC configured; current on-chain state is unavailable.");
    return { liveState, warnings };
  }

  await Promise.all(
    splits.map(async (split) => {
      try {
        liveState.set(split.address, await runtime.reader.readSplitState(split.address));
      } catch (error) {
        warnings.push(
          `Current state for ${split.title} could not be read from the RPC.`
        );
      }
    })
  );

  return { liveState, warnings };
};

/** Builds the snapshot the analysis rules consume. */
const loadSnapshot = async (app) => {
  const { runtime } = app;
  const { prisma, config } = runtime;

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
  const { liveState, warnings } = await readLiveState(runtime, splits);

  let generatedAtBlock = 0;

  if (runtime.reader) {
    try {
      generatedAtBlock = await runtime.reader.getBlockNumber();
    } catch {
      warnings.push("Latest chain block could not be read.");
    }
  }

  if (!generatedAtBlock) {
    const checkpoint = factory
      ? await prisma.indexerCheckpoint.findFirst({
          where: { factoryId: factory.id },
        })
      : null;
    generatedAtBlock = checkpoint ? checkpoint.lastIndexedBlock : 0;
  }

  const snapshot = await buildSnapshotFromIndex({
    prisma,
    config,
    liveState,
    generatedAtBlock,
    historyComplete: true,
  });

  snapshot.warnings = [...snapshot.warnings, ...warnings];

  return snapshot;
};

async function registerRoutes(app) {
  const { runtime } = app;
  const { prisma, config } = runtime;

  // ---------- health ----------
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
              chainId: { type: "integer" },
              factoryAddress: { type: "string" },
              latestIndexedBlock: { type: ["integer", "null"] },
              latestChainBlock: { type: ["integer", "null"] },
              indexerLagBlocks: { type: ["integer", "null"] },
              lastSuccessfulSync: { type: ["string", "null"] },
              secondsSinceSync: { type: ["number", "null"] },
              stale: { type: "boolean" },
              uptimeSeconds: { type: "number" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      let database = "up";
      let status = "ok";

      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        request.log.error({ err: error }, "health: database unreachable");
        database = "down";
        status = "error";
      }

      let latestIndexedBlock = null;
      let lastSuccessfulSync = null;

      if (database === "up") {
        const checkpoint = await prisma.indexerCheckpoint.findFirst({
          where: { chainId: config.chainId },
          orderBy: { updatedAt: "desc" },
        });

        if (checkpoint) {
          latestIndexedBlock = checkpoint.lastIndexedBlock;
          lastSuccessfulSync = checkpoint.lastSyncCompletedAt
            ? checkpoint.lastSyncCompletedAt.toISOString()
            : null;
        }
      }

      let latestChainBlock = null;

      if (runtime.reader) {
        try {
          latestChainBlock = await runtime.reader.getBlockNumber();
        } catch (error) {
          request.log.warn({ err: error }, "health: RPC unreachable");
          status = status === "ok" ? "degraded" : status;
        }
      }

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

      reply.status(database === "down" ? 503 : 200).send({
        status,
        database,
        chainId: config.chainId,
        factoryAddress: String(config.factoryAddress).toLowerCase(),
        latestIndexedBlock,
        latestChainBlock,
        indexerLagBlocks,
        lastSuccessfulSync,
        secondsSinceSync,
        stale,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }
  );

  // ---------- summary ----------
  app.get("/api/v1/web3/summary", async (request, reply) => {
    const snapshot = await loadSnapshot(app);
    const participation = summarizeParticipation(snapshot);

    const totalHeldWei = snapshot.splits.reduce(
      (sum, split) => sum + split.balanceWei,
      0n
    );

    reply.send(
      app.bigintSafe({
        factory: {
          address: snapshot.address,
          version: snapshot.version,
          deploymentBlock: snapshot.deploymentBlock,
          deployedSplitCount: snapshot.deployedSplitCount,
        },
        chainId: config.chainId,
        generatedAtBlock: snapshot.generatedAtBlock,
        totalHeldWei,
        participation,
        warnings: snapshot.warnings,
      })
    );
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
            },
          },
        },
      },
    },
    async (request, reply) => {
      const snapshot = await loadSnapshot(app);

      reply.send(
        app.bigintSafe({
          generatedAtBlock: snapshot.generatedAtBlock,
          splits: snapshot.splits.map(decorateSplit),
          warnings: snapshot.warnings,
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
      const snapshot = await loadSnapshot(app);
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
