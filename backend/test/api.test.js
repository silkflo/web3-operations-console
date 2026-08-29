// backend/test/api.test.js
//
// API contract, validation, error handling, CORS, rate limiting, and the two
// hard security guarantees: no participant address in any response, and no
// write surface anywhere.
//
// Uses app.inject(), so no port is bound and no real HTTP client is needed.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApp } = require("../src/api/app");
const { createIndexer } = require("../src/indexer/indexer");
const { createStubChain, stubConfig } = require("./fixtures/chain");
const {
  createTestPrisma,
  truncateAll,
  skipReason,
} = require("./helpers/test-db");

const skip = skipReason();

/**
 * Builds the API over the TEST database, seeded from the stub chain.
 *
 * The API tests deliberately do NOT read the live development index. They own
 * their data, so they are repeatable, order-independent, and unaffected by
 * whatever the developer last synced.
 */
const withApp = async (fn, { runtimeOverrides = {}, seed = true } = {}) => {
  const prisma = createTestPrisma();
  const chain = createStubChain();
  const config = stubConfig();

  try {
    await truncateAll(prisma);

    if (seed) {
      const indexer = createIndexer({
        prisma,
        reader: chain.reader,
        config,
        logger: { info() {}, warn() {}, error() {} },
      });

      await indexer.sync();
    }

    const runtime = {
      config,
      prisma,
      provider: null,
      reader: chain.reader,
      indexer: null,
      ...runtimeOverrides,
    };

    const app = await buildApp({ runtime, logger: false });

    try {
      await fn(app, runtime);
    } finally {
      await app.close();
    }
  } finally {
    await prisma.$disconnect();
  }
};

// ---------------------------------------------------------------- health ----

test("health reports database, blocks, lag and staleness", { skip }, async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.database, "up");
    assert.ok(["ok", "degraded"].includes(body.status));
    assert.equal(typeof body.chainId, "number");
    assert.match(body.factoryAddress, /^0x[0-9a-f]{40}$/);
    assert.ok("latestIndexedBlock" in body);
    assert.ok("latestChainBlock" in body);
    assert.ok("indexerLagBlocks" in body);
    assert.ok("lastSuccessfulSync" in body);
    assert.equal(typeof body.stale, "boolean");
  });
});

test("health degrades rather than throwing when the RPC is down", { skip }, async () => {
  await withApp(
    async (app) => {
      const res = await app.inject({ method: "GET", url: "/health" });

      assert.equal(res.statusCode, 200, "still answers monitoring");
      assert.equal(res.json().latestChainBlock, null);
    },
    {
      runtimeOverrides: {
        reader: {
          async getBlockNumber() {
            throw new Error("RPC exploded");
          },
          async readSplitState() {
            throw new Error("RPC exploded");
          },
        },
      },
    }
  );
});

// ------------------------------------------------------------ validation ----

test("rejects an unknown question id with 400", { skip }, async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/web3/intelligence/definitely-not-a-question",
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().requestId, "error carries a request id");
  });
});

test("rejects a malformed address with 400", { skip }, async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/web3/splits/not-an-address",
    });

    assert.equal(res.statusCode, 400);
  });
});

test("returns 404 for a well-formed but unknown address", { skip }, async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/web3/splits/0x1111111111111111111111111111111111111111",
    });

    assert.equal(res.statusCode, 404);
  });
});

test("clamps the activity limit", { skip }, async () => {
  await withApp(async (app) => {
    const tooMany = await app.inject({
      method: "GET",
      url: "/api/v1/web3/activity?limit=5000",
    });

    assert.equal(tooMany.statusCode, 400, "limit above the maximum is rejected");

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/web3/activity?limit=3",
    });

    assert.equal(ok.statusCode, 200);
    assert.ok(ok.json().count <= 3);
  });
});


test("activity excludes events from another factory on the same chain", { skip }, async () => {
  await withApp(async (app, runtime) => {
    const foreignFactoryAddress =
      "0xfac7000000000000000000000000000000000002";
    const foreignSplitAddress =
      "0x5f17000000000000000000000000000000000002";
    const foreignTransactionHash = `0x${"fe".repeat(32)}`;

    const foreignFactory = await runtime.prisma.factory.create({
      data: {
        chainId: runtime.config.chainId,
        address: foreignFactoryAddress,
        version: "3.0.0",
        deploymentBlock: 900,
      },
    });

    const foreignSplit = await runtime.prisma.split.create({
      data: {
        factoryId: foreignFactory.id,
        chainId: runtime.config.chainId,
        address: foreignSplitAddress,
        title: "Foreign Factory Split",
        manager: "0xdead0000000000000000000000000000000000aa",
        factoryIndex: 0,
        createdAtBlock: 910,
        createdAtTx: `0x${"fd".repeat(32)}`,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    await runtime.prisma.chainEvent.create({
      data: {
        chainId: runtime.config.chainId,
        address: foreignSplitAddress,
        splitId: foreignSplit.id,
        eventName: "Funded",
        blockNumber: 920,
        blockHash: `0x${"fc".repeat(32)}`,
        transactionHash: foreignTransactionHash,
        logIndex: 0,
        blockTimestamp: new Date("2026-01-01T00:01:00.000Z"),
        args: {
          round: "1",
          amount: "1000",
          roundPoolTotal: "1000",
        },
        round: 1,
        amount: "1000",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/web3/activity?limit=200",
    });

    assert.equal(response.statusCode, 200);

    const body = response.json();

    assert.ok(body.count > 0, "active factory events remain visible");
    assert.ok(
      !body.events.some(
        (event) => event.transactionHash === foreignTransactionHash
      ),
      "foreign-factory event must not appear"
    );
    assert.ok(
      !response.payload.toLowerCase().includes(foreignSplitAddress),
      "foreign split address must not appear"
    );
  });
});

test("404s an unknown route with a structured body", { skip }, async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    const body = res.json();

    assert.equal(res.statusCode, 404);
    assert.equal(body.statusCode, 404);
    assert.ok(body.requestId);
  });
});

test("never leaks a raw database error to the client", { skip }, async () => {
  await withApp(
    async (app) => {
      const res = await app.inject({ method: "GET", url: "/api/v1/web3/summary" });
      const raw = res.payload;

      assert.equal(res.statusCode, 500);
      assert.ok(!/prisma/i.test(raw), "no Prisma detail in the response");
      assert.ok(!/postgres/i.test(raw), "no database detail in the response");
      assert.match(res.json().message, /could not complete/i);
      assert.ok(res.json().requestId);
    },
    {
      runtimeOverrides: {
        prisma: {
          factory: {
            findUnique() {
              const error = new Error(
                "Invalid `prisma.factory.findUnique()` — postgres://user:password@host/db"
              );
              error.name = "PrismaClientKnownRequestError";
              throw error;
            },
          },
        },
      },
    }
  );
});

// ------------------------------------------------------------------ CORS ----

test("allows a configured origin and refuses others", { skip }, async () => {
  await withApp(async (app) => {
    const allowed = app.runtime.config.api.corsOrigins[0];

    const good = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: allowed },
    });
    assert.equal(good.headers["access-control-allow-origin"], allowed);

    const bad = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://attacker.example" },
    });
    assert.equal(bad.headers["access-control-allow-origin"], undefined);
  });
});

test("public reads require no credentials", { skip }, async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: app.runtime.config.api.corsOrigins[0] },
    });

    assert.notEqual(
      res.headers["access-control-allow-credentials"],
      "true",
      "cookies must not be part of the public read contract"
    );
  });
});

// ----------------------------------------------------------- rate limit ----

test("rate limits repeated requests but never /health", { skip }, async () => {
  await withApp(async (app) => {
    const max = app.runtime.config.api.rateLimitMax;
    let limited = false;

    for (let i = 0; i < max + 5; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/web3/questions",
        headers: { "x-forwarded-for": "203.0.113.9" },
      });

      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }

    assert.ok(limited, "public endpoint is rate limited");

    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });

    assert.notEqual(health.statusCode, 429, "monitoring must not be locked out");
  });
});

// -------------------------------------------------------------- security ----

test("no participant address appears in any response", { skip }, async () => {
  await withApp(async (app, runtime) => {
    const rows = await runtime.prisma.chainEvent.findMany({
      where: { eventName: { in: ["ParticipantJoined", "Withdrawal"] } },
    });

    const participants = [
      ...new Set(
        rows
          .map((row) => row.args && row.args.participant)
          .filter(Boolean)
          .map((address) => String(address).toLowerCase())
      ),
    ];

    assert.ok(participants.length > 0, "seeded fixture has participant addresses to leak");

    const urls = [
      "/health",
      "/api/v1/web3/summary",
      "/api/v1/web3/splits",
      "/api/v1/web3/activity?limit=200",
      "/api/v1/web3/questions",
      "/api/v1/web3/intelligence/explain-factory",
      "/api/v1/web3/intelligence/recent-activity",
      "/api/v1/web3/intelligence/active-splits",
      "/api/v1/web3/intelligence/eth-held",
      "/api/v1/web3/intelligence/explain-creator-revenue-share",
    ];

    for (const url of urls) {
      const res = await app.inject({ method: "GET", url });
      const payload = res.payload.toLowerCase();

      participants.forEach((address) => {
        assert.ok(
          !payload.includes(address),
          `${url} leaked participant address ${address}`
        );
      });
    }
  });
});

test("exposes no write route", { skip }, async () => {
  await withApp(async (app) => {
    const routes = app.printRoutes({ commonPrefix: false });

    ["POST", "PUT", "PATCH", "DELETE"].forEach((verb) => {
      assert.ok(
        !routes.includes(verb),
        `router must expose no ${verb} route, got:\n${routes}`
      );
    });
  });
});

test("rejects a write attempt on a read route", { skip }, async () => {
  await withApp(async (app) => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await app.inject({
        method,
        url: "/api/v1/web3/summary",
        payload: {},
      });

      assert.equal(res.statusCode, 404, `${method} must not be routed`);
    }
  });
});

// ----------------------------------------------------------- answer shape ----

test("every guided answer carries evidence and a block reference", { skip }, async () => {
  await withApp(async (app) => {
    const ids = [
      "explain-factory",
      "recent-activity",
      "active-splits",
      "eth-held",
      "explain-creator-revenue-share",
    ];

    for (const id of ids) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/web3/intelligence/${id}`,
      });

      assert.equal(res.statusCode, 200, id);

      const answer = res.json();

      assert.equal(answer.id, id);
      assert.ok(answer.title, `${id} has a title`);
      assert.ok(answer.summary, `${id} has a summary`);
      assert.ok(["ok", "partial", "empty"].includes(answer.status), id);
      assert.ok(Array.isArray(answer.facts) && answer.facts.length > 0, id);
      assert.ok(Array.isArray(answer.evidence) && answer.evidence.length > 0, id);
      assert.equal(typeof answer.generatedAtBlock, "number", id);

      answer.evidence.forEach((item) => {
        assert.ok(item.label, "evidence is labelled");
        assert.match(item.etherscanUrl, /^https:\/\/sepolia\.etherscan\.io\//);
      });

      answer.facts.forEach((fact) => {
        assert.ok(
          ["read", "event", "derived"].includes(fact.source),
          `${id} fact source must be read|event|derived, got ${fact.source}`
        );
      });
    }
  });
});

test("splits carry description and lifecycle prose from the server", { skip }, async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: "GET", url: "/api/v1/web3/splits" });
    const { splits } = res.json();

    assert.ok(splits.length > 0);

    splits.forEach((split) => {
      assert.equal(typeof split.lifecycleExplanation, "string");
      assert.ok(split.lifecycleExplanation.length > 0);
      // wei values cross the wire as strings so precision survives JSON.
      assert.equal(typeof split.balanceWei, "string");
      assert.equal(typeof split.totalClaimableWei, "string");
    });
  });
});
