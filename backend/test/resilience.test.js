// backend/test/resilience.test.js
//
// What the API and the indexer do when the RPC is slow, throttled or gone.
//
// The incident these tests encode: an authenticated endpoint began returning
// `429 Monthly capacity limit exceeded`; ethers retried each call twelve times
// over four minutes; `/health`, `/splits` and `/summary` all hung; Nginx
// returned 504 at thirty seconds; the dashboard went dark. Every test below
// pins one link in that chain.
//
// Suites needing PostgreSQL skip themselves, with a reason, when no isolated
// test database is configured.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApp } = require("../src/api/app");
const { createIndexer } = require("../src/indexer/indexer");
const { createChainReader } = require("../src/chain/reader");
const { createCachedResource } = require("../src/util/cached-resource");
const { withTimeout, backoffDelay, RpcTimeoutError } = require("../src/util/timeout");
const {
  createStubChain,
  stubConfig,
  SPLIT_A,
  SPLIT_B,
} = require("./fixtures/chain");
const {
  createTestPrisma,
  truncateAll,
  skipReason,
} = require("./helpers/test-db");

const skip = skipReason();

/** Never settles. The provider shape that used to hold a request for minutes. */
const forever = () => new Promise(() => {});

const rateLimitError = () => {
  const error = new Error("exceeded maximum retry limit");
  error.code = "SERVER_ERROR";
  error.info = {
    requestUrl: "https://rpc.example.com/v2/KEY",
    responseStatus:
      "599 CLIENT ESCALATED SERVER ERROR (429 Too Many Requests; exceeded maximum retry limit)",
    responseBody: '{"error":{"message":"Monthly capacity limit exceeded"}}',
  };
  return error;
};

const rangeTooLargeError = () => {
  const error = new Error("query returned more than 10000 results");
  error.code = "SERVER_ERROR";
  return error;
};

/**
 * Wraps a stub reader so a test can turn contract reads off mid-run.
 *
 * The interesting failure is not "the RPC was down from the start"; it is "the
 * RPC worked, then stopped", because that is when there is a good snapshot to
 * either preserve or destroy.
 */
const switchableReader = (reader) => {
  const state = { failSplits: new Set(), failAll: false, failHead: false };

  return {
    state,
    reader: {
      ...reader,
      async getBlockNumber() {
        if (state.failHead) {
          throw rateLimitError();
        }

        return reader.getBlockNumber();
      },
      async readSplitState(address) {
        if (state.failAll || state.failSplits.has(address.toLowerCase())) {
          throw rateLimitError();
        }

        return reader.readSplitState(address);
      },
    },
  };
};

/**
 * Builds the API over the TEST database, seeded from the stub chain.
 *
 * Mirrors api.test.js so both suites see the same fixture.
 */
const withApp = async (fn, { runtimeOverrides = {}, configOverrides = {}, seed = true } = {}) => {
  const prisma = createTestPrisma();
  const chain = createStubChain();
  const config = stubConfig(configOverrides);

  try {
    await truncateAll(prisma);

    if (seed) {
      await createIndexer({
        prisma,
        reader: chain.reader,
        config,
        logger: { info() {}, warn() {}, error() {} },
      }).sync();
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
      await fn(app, { runtime, chain, config });
    } finally {
      await app.close();
    }
  } finally {
    await prisma.$disconnect();
  }
};

// ------------------------------------------------------- bounded RPC latency ----

test("the chain reader gives up on a hanging provider at its configured bound", async () => {
  const reader = createChainReader({
    provider: { getBlockNumber: forever, getBlock: forever },
    createContract: () => ({}),
    timeoutMs: 150,
  });

  const started = Date.now();

  await assert.rejects(
    () => reader.getBlockNumber(),
    (error) => error instanceof RpcTimeoutError && error.code === "RPC_TIMEOUT"
  );

  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 140, `returned suspiciously early: ${elapsed}ms`);
  assert.ok(elapsed < 2000, `exceeded the configured bound: ${elapsed}ms`);
});

test("a hanging live read bounds readSplitState too", async () => {
  const reader = createChainReader({
    provider: {},
    createContract: () => ({
      title: forever,
      VERSION: forever,
      round: forever,
      participantCount: forever,
      contractBalance: forever,
      availableForDistribution: forever,
      totalClaimable: forever,
    }),
    timeoutMs: 150,
  });

  const started = Date.now();

  await assert.rejects(() => reader.readSplitState(SPLIT_A), RpcTimeoutError);
  assert.ok(Date.now() - started < 2000);
});

test("withTimeout does not leave the process holding a timer", async () => {
  // A rejected race must clear its timer, or an abandoned RPC call keeps the
  // event loop alive and a graceful shutdown never finishes.
  await assert.rejects(() => withTimeout(forever(), 20, "probe"), RpcTimeoutError);
  await withTimeout(Promise.resolve("done"), 1000, "probe");
});

test("backoff is exponential, jittered and capped", () => {
  const highest = backoffDelay(20, { baseMs: 1000, maxMs: 30000, random: () => 1 });
  const lowest = backoffDelay(20, { baseMs: 1000, maxMs: 30000, random: () => 0 });

  assert.equal(highest, 30000, "never exceeds the cap");
  assert.equal(lowest, 15000, "jitter spreads over the lower half");

  const first = backoffDelay(1, { baseMs: 1000, maxMs: 30000, random: () => 0 });
  const second = backoffDelay(2, { baseMs: 1000, maxMs: 30000, random: () => 0 });

  assert.ok(second > first, "delay grows with the attempt count");
});

// ------------------------------------------------ caching and coalescing ----

test("a cached resource coalesces concurrent callers into one load", async () => {
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const resource = createCachedResource({
    ttlMs: 60000,
    maxStaleMs: 60000,
    load: async () => {
      loads += 1;
      await gate;
      return "value";
    },
  });

  const waiters = [resource.get(), resource.get(), resource.get()];
  release();

  const results = await Promise.all(waiters);

  assert.equal(loads, 1, "three concurrent callers, one load");
  results.forEach((result) => assert.equal(result.value, "value"));
});

test("a cache hit inside the TTL performs no load at all", async () => {
  let loads = 0;
  let clock = 0;

  const resource = createCachedResource({
    ttlMs: 1000,
    maxStaleMs: 10000,
    now: () => clock,
    load: async () => {
      loads += 1;
      return loads;
    },
  });

  await resource.get();
  clock = 500;
  const cached = await resource.get();

  assert.equal(loads, 1);
  assert.equal(cached.state, "cached");

  clock = 1500;
  const refreshed = await resource.get();

  assert.equal(loads, 2, "the TTL expiring does refresh");
  assert.equal(refreshed.state, "fresh");
});

test("a failed refresh serves the last known good value, labelled stale", async () => {
  let clock = 0;
  let fail = false;

  const resource = createCachedResource({
    ttlMs: 100,
    maxStaleMs: 10000,
    cooldownMs: 0,
    now: () => clock,
    load: async () => {
      if (fail) {
        throw rateLimitError();
      }

      return "good";
    },
  });

  await resource.get();

  fail = true;
  clock = 500;

  const stale = await resource.get();

  assert.equal(stale.state, "stale");
  assert.equal(stale.value, "good", "the previous value survives");
  assert.ok(stale.error, "the failure is reported alongside it");
});

test("maxStaleMs 0 means never serve stale, not serve forever", () => {
  // The dangerous reading of `0` is "unlimited". An operator setting the
  // maximum stale age to zero is asking for stale data NOT to be served, and
  // the opposite behaviour would only be discovered during an incident.
  let clock = 0;
  let fail = false;

  const resource = createCachedResource({
    ttlMs: 10,
    maxStaleMs: 0,
    now: () => clock,
    load: async () => {
      if (fail) {
        throw new Error("down");
      }

      return "good";
    },
  });

  return (async () => {
    await resource.get();

    fail = true;
    clock = 50;

    const result = await resource.get();

    assert.equal(result.state, "unavailable");
    assert.equal(result.value, null, "the value is dropped, not served");
  })();
});

test("maxStaleMs Infinity serves the last good value indefinitely", async () => {
  let clock = 0;
  let fail = false;

  const resource = createCachedResource({
    ttlMs: 10,
    maxStaleMs: Infinity,
    now: () => clock,
    load: async () => {
      if (fail) {
        throw new Error("down");
      }

      return "good";
    },
  });

  await resource.get();

  fail = true;
  clock = 100000000;

  const result = await resource.get();

  assert.equal(result.state, "stale");
  assert.equal(result.value, "good");
});

test("a negative maxStaleMs is rejected rather than silently reinterpreted", () => {
  assert.throws(
    () => createCachedResource({ maxStaleMs: -1, load: async () => 1 }),
    RangeError
  );
});

test("the error cooldown stops a failing provider being asked on every request", async () => {
  let loads = 0;
  let clock = 0;

  const resource = createCachedResource({
    ttlMs: 10,
    maxStaleMs: 10000,
    cooldownMs: 1000,
    now: () => clock,
    load: async () => {
      loads += 1;
      throw rateLimitError();
    },
  });

  await resource.get();
  clock = 100;
  await resource.get();
  clock = 200;
  await resource.get();

  assert.equal(loads, 1, "one attempt, then the cooldown holds");

  clock = 1500;
  await resource.get();

  assert.equal(loads, 2, "and it does try again once the cooldown expires");
});

// --------------------------------------------------------- API behaviour ----

test(
  "splits, summary and dashboard together perform one set of live reads",
  { skip },
  async () => {
    await withApp(async (app, { chain }) => {
      const before = chain.calls.readSplitState;

      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/api/v1/web3/splits" }),
        app.inject({ method: "GET", url: "/api/v1/web3/summary" }),
        app.inject({ method: "GET", url: "/api/v1/web3/dashboard" }),
      ]);

      responses.forEach((response) => assert.equal(response.statusCode, 200));

      const splitCount = responses[0].json().splits.length;
      const reads = chain.calls.readSplitState - before;

      assert.equal(
        reads,
        splitCount,
        `three endpoints must share one refresh: expected ${splitCount} live ` +
          `reads, got ${reads}`
      );
    });
  }
);

test("a second request inside the TTL makes no RPC call", { skip }, async () => {
  await withApp(async (app, { chain }) => {
    await app.inject({ method: "GET", url: "/api/v1/web3/splits" });

    const afterFirst = chain.calls.readSplitState;
    const headAfterFirst = chain.calls.getBlockNumber;

    await app.inject({ method: "GET", url: "/api/v1/web3/splits" });
    await app.inject({ method: "GET", url: "/api/v1/web3/summary" });

    assert.equal(chain.calls.readSplitState, afterFirst, "no extra live reads");
    assert.equal(chain.calls.getBlockNumber, headAfterFirst, "no extra head reads");
  });
});

test("the snapshot is marked fresh, then cached", { skip }, async () => {
  await withApp(async (app) => {
    const first = await app.inject({ method: "GET", url: "/api/v1/web3/splits" });
    const second = await app.inject({ method: "GET", url: "/api/v1/web3/splits" });

    assert.equal(first.json().freshness.state, "fresh");
    assert.equal(first.json().freshness.servedFromCache, false);
    assert.equal(second.json().freshness.state, "cached");
    assert.equal(second.json().freshness.servedFromCache, true);
    assert.equal(second.json().freshness.source, "live");
  });
});

test(
  "a rate-limited RPC still answers, from the index, honestly labelled",
  { skip },
  async () => {
    await withApp(
      async (app) => {
        const started = Date.now();
        const response = await app.inject({
          method: "GET",
          url: "/api/v1/web3/dashboard",
        });
        const elapsed = Date.now() - started;

        assert.equal(response.statusCode, 200, "the dashboard still renders");
        assert.ok(elapsed < 10000, `took ${elapsed}ms; Nginx gives up at 30s`);

        const body = response.json();

        assert.ok(body.splits.length > 0, "indexed history is still served");
        assert.equal(body.freshness.state, "degraded");
        assert.equal(body.freshness.source, "index");
        assert.equal(body.freshness.degraded, true);
        assert.equal(body.health.rpc, "degraded");
        assert.ok(
          body.warnings.some((warning) => /could not be read from the RPC/i.test(warning)),
          `expected an honest warning, got ${JSON.stringify(body.warnings)}`
        );
        assert.ok(
          !JSON.stringify(body).includes("KEY"),
          "no credential fragment reaches a response body"
        );
      },
      {
        runtimeOverrides: {
          reader: {
            async getBlockNumber() {
              throw rateLimitError();
            },
            async readSplitState() {
              throw rateLimitError();
            },
          },
        },
      }
    );
  }
);

test(
  "a 429 costs one attempt per refresh, not a retry storm",
  { skip },
  async () => {
    let attempts = 0;

    await withApp(
      async (app) => {
        for (let i = 0; i < 5; i += 1) {
          await app.inject({ method: "GET", url: "/health" });
          await app.inject({ method: "GET", url: "/api/v1/web3/summary" });
        }

        // One head read and one read per split for the single refresh; the
        // cooldown absorbs everything after that. Before the fix this was 12
        // HTTP attempts per logical call, per endpoint, per poll.
        assert.ok(
          attempts <= 3,
          `expected the failing provider to be spared, got ${attempts} attempts`
        );
      },
      {
        runtimeOverrides: {
          reader: {
            async getBlockNumber() {
              attempts += 1;
              throw rateLimitError();
            },
            async readSplitState() {
              attempts += 1;
              throw rateLimitError();
            },
          },
        },
      }
    );
  }
);

test("health answers quickly while the RPC hangs", { skip }, async () => {
  await withApp(
    async (app) => {
      const started = Date.now();
      const response = await app.inject({ method: "GET", url: "/health" });
      const elapsed = Date.now() - started;

      assert.equal(response.statusCode, 200);
      assert.ok(elapsed < 3000, `health took ${elapsed}ms while the RPC hung`);

      const body = response.json();

      assert.equal(body.latestChainBlock, null);
      assert.ok(["degraded", "error"].includes(body.status));
      assert.ok(["down", "degraded"].includes(body.rpc));
      assert.equal(typeof body.servingStaleData, "boolean");
      assert.equal(typeof body.snapshotState, "string");
    },
    {
      configOverrides: {
        // The hard bound under test. Kept small so the suite stays quick.
        api: { ...stubConfig().api, healthTimeoutMs: 300 },
      },
      runtimeOverrides: {
        reader: {
          getBlockNumber: forever,
          readSplitState: forever,
        },
      },
    }
  );
});

test("health reports the fields an external monitor needs", { skip }, async () => {
  await withApp(async (app) => {
    const body = (await app.inject({ method: "GET", url: "/health" })).json();

    [
      "status",
      "database",
      "rpc",
      "latestIndexedBlock",
      "latestChainBlock",
      "indexerLagBlocks",
      "lastSuccessfulSync",
      "stale",
      "servingCachedData",
      "servingStaleData",
    ].forEach((field) => {
      assert.ok(field in body, `health must expose ${field}`);
    });

    assert.equal(body.rpc, "up");
  });
});

test("the dashboard exposes no participant address", { skip }, async () => {
  await withApp(async (app, { runtime }) => {
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

    assert.ok(participants.length > 0, "the fixture has addresses to leak");

    const payload = (
      await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
    ).payload.toLowerCase();

    participants.forEach((address) => {
      assert.ok(!payload.includes(address), `dashboard leaked ${address}`);
    });
  });
});

test("the dashboard adds no write route", { skip }, async () => {
  await withApp(async (app) => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await app.inject({
        method,
        url: "/api/v1/web3/dashboard",
        payload: {},
      });

      assert.equal(response.statusCode, 404, `${method} must not be routed`);
    }
  });
});

// ------------------------------------- current state is never invented ----

test(
  "an RPC failure preserves the exact balances from the last good read",
  { skip },
  async () => {
    const prisma = createTestPrisma();
    const chain = createStubChain();
    // A zero TTL means every request refreshes, which is how this test
    // reproduces "the cached snapshot expired" without calling clear() — that
    // resets the service completely, last-known-good reads included.
    const base = stubConfig();
    const config = stubConfig({
      api: { ...base.api, snapshotTtlSeconds: 0 },
    });
    const switchable = switchableReader(chain.reader);

    try {
      await truncateAll(prisma);
      await createIndexer({
        prisma,
        reader: chain.reader,
        config,
        logger: { info() {}, warn() {}, error() {} },
      }).sync();

      const app = await buildApp({
        runtime: {
          config,
          prisma,
          provider: null,
          reader: switchable.reader,
          indexer: null,
        },
        logger: false,
      });

      try {
        // A healthy refresh first, so there IS a last-known-good to keep.
        const healthy = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        assert.equal(healthy.freshness.source, "live");

        const before = new Map(
          healthy.splits.map((split) => [split.address, split])
        );

        // Now the RPC stops answering.
        switchable.state.failAll = true;

        const after = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        assert.equal(after.freshness.source, "last-known-good");
        assert.equal(after.freshness.degraded, true);
        assert.equal(after.freshness.currentState.lastKnownGood, before.size);
        assert.equal(after.freshness.currentState.live, 0);

        after.splits.forEach((split) => {
          const previous = before.get(split.address);

          assert.ok(previous, `unexpected split ${split.address}`);

          // The exact values, not a plausible-looking substitute.
          assert.equal(
            split.balanceWei,
            previous.balanceWei,
            `${split.title}: balance was replaced`
          );
          assert.equal(split.roundPoolWei, previous.roundPoolWei);
          assert.equal(split.totalClaimableWei, previous.totalClaimableWei);
          assert.equal(
            split.currentParticipantCount,
            previous.currentParticipantCount
          );
          assert.equal(split.currentStateSource, "last-known-good");
        });

        // And it says so, rather than presenting them as current.
        assert.ok(
          after.warnings.some((warning) =>
            /not current live-chain values/i.test(warning)
          ),
          `expected an honest warning, got ${JSON.stringify(after.warnings)}`
        );
      } finally {
        await app.close();
      }
    } finally {
      await prisma.$disconnect();
    }
  }
);

test(
  "a cold start with no RPC does not invent zero current values",
  { skip },
  async () => {
    await withApp(
      async (app) => {
        const body = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        assert.equal(body.freshness.source, "index");
        assert.equal(body.freshness.currentState.live, 0);
        assert.equal(body.freshness.currentState.lastKnownGood, 0);
        assert.equal(
          body.freshness.currentState.derived,
          body.freshness.currentState.total
        );

        const splitA = body.splits.find(
          (split) => split.address.toLowerCase() === SPLIT_A
        );

        assert.ok(splitA, "the funded split is present");

        // Split A was funded 1000000000000000, distributed 999999999999999 and
        // withdrawn 333333333333333. Its balance is NOT zero, and claiming zero
        // for a funded contract was exactly the defect.
        assert.notEqual(splitA.balanceWei, "0", "balance must not be invented");
        assert.equal(splitA.balanceWei, "666666666666667");
        assert.equal(splitA.totalClaimableWei, "666666666666666");
        assert.equal(splitA.roundPoolWei, "1");
        assert.equal(splitA.currentRound, 2, "round derived from finalizations");
        assert.equal(splitA.currentStateSource, "derived");

        const splitB = body.splits.find(
          (split) => split.address.toLowerCase() === SPLIT_B
        );

        // Split B genuinely holds nothing and has four joiners: a derived zero
        // is a real sum over its history, not a placeholder.
        assert.equal(splitB.balanceWei, "0");
        assert.equal(splitB.currentParticipantCount, 4);
        assert.equal(splitB.currentStateSource, "derived");
      },
      {
        runtimeOverrides: {
          reader: {
            async getBlockNumber() {
              throw rateLimitError();
            },
            async readSplitState() {
              throw rateLimitError();
            },
          },
        },
      }
    );
  }
);

test(
  "derived current state matches what a live read would have returned",
  { skip },
  async () => {
    // The strongest available check on the derivation: for this fixture the
    // reconstruction must equal the stub contract's own view, field for field.
    const prisma = createTestPrisma();
    const chain = createStubChain();
    const config = stubConfig();
    const switchable = switchableReader(chain.reader);

    try {
      await truncateAll(prisma);
      await createIndexer({
        prisma,
        reader: chain.reader,
        config,
        logger: { info() {}, warn() {}, error() {} },
      }).sync();

      const app = await buildApp({
        runtime: {
          config,
          prisma,
          provider: null,
          reader: switchable.reader,
          indexer: null,
        },
        logger: false,
      });

      try {
        const live = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        // Wipe every trace of the live read, so the rebuild must derive rather
        // than fall back to a remembered value.
        switchable.state.failAll = true;
        app.snapshots.clear();

        const derived = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        assert.equal(derived.freshness.source, "index");

        const byAddress = new Map(
          live.splits.map((split) => [split.address, split])
        );

        derived.splits.forEach((split) => {
          const expected = byAddress.get(split.address);

          assert.equal(split.balanceWei, expected.balanceWei, split.title);
          assert.equal(split.roundPoolWei, expected.roundPoolWei, split.title);
          assert.equal(
            split.totalClaimableWei,
            expected.totalClaimableWei,
            split.title
          );
          assert.equal(split.currentRound, expected.currentRound, split.title);
          assert.equal(
            split.currentParticipantCount,
            expected.currentParticipantCount,
            split.title
          );
        });
      } finally {
        await app.close();
      }
    } finally {
      await prisma.$disconnect();
    }
  }
);

test(
  "no ContractRead evidence exists without a successful read",
  { skip },
  async () => {
    await withApp(
      async (app) => {
        const body = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        body.splits.forEach((split) => {
          const reads = split.evidence.filter(
            (item) => item.type === "ContractRead"
          );

          assert.equal(
            reads.length,
            0,
            `${split.title} cites a contract read that never happened: ` +
              JSON.stringify(reads)
          );

          assert.ok(
            split.evidence.some((item) => item.type === "IndexedEvents"),
            `${split.title} must say where its current state actually came from`
          );
        });

        // Historical evidence is still there: an outage costs current state,
        // not the indexed history.
        assert.ok(
          body.splits.every((split) =>
            split.evidence.some((item) => item.type === "SplitCreated")
          ),
          "indexed history must survive an RPC outage"
        );
      },
      {
        runtimeOverrides: {
          reader: {
            async getBlockNumber() {
              throw rateLimitError();
            },
            async readSplitState() {
              throw rateLimitError();
            },
          },
        },
      }
    );
  }
);

test("a healthy snapshot does cite its contract reads", { skip }, async () => {
  await withApp(async (app) => {
    const body = (
      await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
    ).json();

    assert.equal(body.freshness.source, "live");

    body.splits.forEach((split) => {
      assert.equal(split.currentStateSource, "live");
      assert.ok(
        split.evidence.some((item) => item.type === "ContractRead"),
        `${split.title} read live but cites no read`
      );
    });
  });
});

test(
  "a partial split failure is never described as a live snapshot",
  { skip },
  async () => {
    const prisma = createTestPrisma();
    const chain = createStubChain();
    const config = stubConfig();
    const switchable = switchableReader(chain.reader);

    // Only one split refuses to answer.
    switchable.state.failSplits.add(SPLIT_B);

    try {
      await truncateAll(prisma);
      await createIndexer({
        prisma,
        reader: chain.reader,
        config,
        logger: { info() {}, warn() {}, error() {} },
      }).sync();

      const app = await buildApp({
        runtime: {
          config,
          prisma,
          provider: null,
          reader: switchable.reader,
          indexer: null,
        },
        logger: false,
      });

      try {
        const body = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        assert.notEqual(
          body.freshness.source,
          "live",
          "one failed split must disqualify the whole snapshot from 'live'"
        );
        assert.equal(body.freshness.source, "mixed");
        assert.equal(body.freshness.degraded, true);
        assert.equal(body.freshness.currentState.total, 2, "fixture size");
        assert.equal(body.freshness.currentState.live, 1);
        assert.equal(body.freshness.currentState.derived, 1);
        assert.equal(body.health.rpc, "degraded");

        const failed = body.splits.find(
          (split) => split.address.toLowerCase() === SPLIT_B
        );
        const succeeded = body.splits.find(
          (split) => split.address.toLowerCase() === SPLIT_A
        );

        assert.equal(failed.currentStateSource, "derived");
        assert.equal(succeeded.currentStateSource, "live");

        assert.equal(
          failed.evidence.filter((item) => item.type === "ContractRead").length,
          0
        );
        assert.ok(
          succeeded.evidence.some((item) => item.type === "ContractRead"),
          "the split that WAS read must still cite its read"
        );
      } finally {
        await app.close();
      }
    } finally {
      await prisma.$disconnect();
    }
  }
);

// ------------------------------------------------- chain-head reporting ----

test(
  "with no chain head, latestChainBlock and lag are null, not zero",
  { skip },
  async () => {
    await withApp(
      async (app) => {
        const body = (
          await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
        ).json();

        // generatedAtBlock falls back to the indexer cursor, which is a real
        // block — but it is NOT the chain head. Reporting it as one made the
        // API claim a lag of zero at the exact moment it could not see the
        // chain at all.
        assert.equal(body.health.latestChainBlock, null);
        assert.equal(body.health.indexerLagBlocks, null);
        assert.equal(body.freshness.generatedAtBlockIsChainHead, false);
        assert.ok(
          body.generatedAtBlock > 0,
          "the snapshot still reports the block it describes"
        );
        assert.notEqual(
          body.health.latestChainBlock,
          body.generatedAtBlock,
          "the indexed block must not be published as the chain head"
        );
      },
      {
        runtimeOverrides: {
          reader: {
            async getBlockNumber() {
              throw rateLimitError();
            },
            async readSplitState() {
              throw rateLimitError();
            },
          },
        },
      }
    );
  }
);

test("with a chain head, lag is reported normally", { skip }, async () => {
  await withApp(async (app, { chain }) => {
    const body = (
      await app.inject({ method: "GET", url: "/api/v1/web3/dashboard" })
    ).json();

    assert.equal(body.health.latestChainBlock, chain.state.head);
    assert.equal(typeof body.health.indexerLagBlocks, "number");
    assert.equal(body.freshness.generatedAtBlockIsChainHead, true);
  });
});

// ------------------------------------------------------ indexer stability ----

const withIndexer = async (fn, { configOverrides = {}, indexerOverrides = {} } = {}) => {
  const prisma = createTestPrisma();
  const chain = createStubChain();
  const config = stubConfig(configOverrides);

  try {
    await truncateAll(prisma);

    const waits = [];
    const indexer = createIndexer({
      prisma,
      reader: chain.reader,
      config,
      logger: { info() {}, warn() {}, error() {} },
      // Backoff is asserted by what it asks to wait for, not by waiting.
      wait: async (ms) => {
        waits.push(ms);
      },
      random: () => 0.5,
      ...indexerOverrides,
    });

    await fn({ prisma, chain, config, indexer, waits });
  } finally {
    await prisma.$disconnect();
  }
};

test("indexer passes cannot overlap", { skip }, async () => {
  await withIndexer(async ({ indexer, chain }) => {
    const before = chain.calls.fetchFactoryLogs;

    const [first, second] = await Promise.all([indexer.sync(), indexer.sync()]);

    const passes = chain.calls.fetchFactoryLogs - before;

    assert.equal(second.coalesced, true, "the second caller joined the first");
    assert.equal(first.events, second.events, "both see the same result");
    assert.ok(passes > 0, "one pass ran");

    // A second, sequential call is a genuinely new pass.
    assert.equal(indexer.isRunning(), false);
  });
});

test("a rate-limited pass backs off a bounded number of times", { skip }, async () => {
  const prisma = createTestPrisma();
  const chain = createStubChain();
  const config = stubConfig();

  try {
    await truncateAll(prisma);

    let attempts = 0;
    const waits = [];

    const reader = {
      ...chain.reader,
      async fetchFactoryLogs() {
        attempts += 1;
        throw rateLimitError();
      },
    };

    const indexer = createIndexer({
      prisma,
      reader,
      config,
      logger: { info() {}, warn() {}, error() {} },
      wait: async (ms) => {
        waits.push(ms);
      },
      random: () => 0.5,
    });

    await assert.rejects(() => indexer.sync());

    // Bounded: it gives up and lets the caller back off, rather than hammering
    // a provider that has already said no. Ethers alone would have made twelve
    // HTTP attempts inside every one of these.
    assert.equal(
      attempts,
      config.indexer.maxAttempts,
      `expected ${config.indexer.maxAttempts} attempts, got ${attempts}`
    );
    assert.equal(waits.length, config.indexer.maxAttempts - 1);

    waits.forEach((delay) => {
      assert.ok(delay > 0, "each backoff actually waits");
      assert.ok(
        delay <= config.indexer.backoffMaxMs,
        `backoff ${delay} exceeded the cap`
      );
    });

    for (let i = 1; i < waits.length; i += 1) {
      assert.ok(waits[i] >= waits[i - 1], "backoff grows with the attempt");
    }
  } finally {
    await prisma.$disconnect();
  }
});

test(
  "a provider that refuses the range gets a smaller one, not a retry storm",
  { skip },
  async () => {
    const prisma = createTestPrisma();
    const chain = createStubChain();
    const config = stubConfig();

    try {
      await truncateAll(prisma);

      let refusals = 0;
      const waits = [];

      const reader = {
        ...chain.reader,
        async fetchFactoryLogs(address, fromBlock, toBlock) {
          // Refuse anything wider than 12 blocks, the way a capped public
          // endpoint does, without saying what the cap is.
          if (toBlock - fromBlock + 1 > 12) {
            refusals += 1;
            throw rangeTooLargeError();
          }

          return chain.reader.fetchFactoryLogs(address, fromBlock, toBlock);
        },
      };

      const indexer = createIndexer({
        prisma,
        reader,
        config,
        logger: { info() {}, warn() {}, error() {} },
        wait: async (ms) => {
          waits.push(ms);
        },
      });

      const result = await indexer.sync();

      assert.ok(refusals > 0, "the fixture actually refused a range");
      assert.equal(waits.length, 0, "a range refusal must not trigger a backoff");
      assert.ok(result.events > 0, "the pass still completed");
      assert.ok(
        indexer.currentChunkSize() <= 12,
        `chunk size did not adapt: ${indexer.currentChunkSize()}`
      );
      assert.ok(
        indexer.currentChunkSize() >= config.indexer.minChunkSize,
        "and never went below the configured floor"
      );
    } finally {
      await prisma.$disconnect();
    }
  }
);

test("a pass is bounded by the per-pass block budget", { skip }, async () => {
  await withIndexer(
    async ({ indexer, chain }) => {
      chain.advance(500);

      const first = await indexer.sync();

      assert.equal(first.caughtUp, false, "a capped pass reports it is behind");
      assert.ok(
        first.to - first.from + 1 <= 40,
        `pass covered ${first.to - first.from + 1} blocks, budget was 40`
      );

      // Repeated passes still reach the head: the cap paces, it does not stall.
      let guard = 0;
      let result = first;

      while (!result.caughtUp && guard < 100) {
        result = await indexer.sync();
        guard += 1;
      }

      assert.equal(result.caughtUp, true, "catch-up completes across passes");
    },
    { configOverrides: { indexer: { ...stubConfig().indexer, maxBlocksPerPass: 40 } } }
  );
});

test("indexer errors are recorded without the RPC credential", { skip }, async () => {
  await withIndexer(async ({ indexer, prisma, config }) => {
    await indexer.sync();
    await indexer.recordError(rateLimitError());

    const checkpoint = await prisma.indexerCheckpoint.findFirst({
      where: { chainId: config.chainId },
    });

    assert.ok(checkpoint.lastError, "the failure is recorded");
    assert.ok(
      !checkpoint.lastError.includes("/v2/KEY"),
      `credential persisted to the database: ${checkpoint.lastError}`
    );
    assert.match(checkpoint.lastError, /rate-limited/, "the category survives");
    assert.match(checkpoint.lastError, /rpc\.example\.com/, "the host survives");
  });
});

test("restart safety and idempotency survive the changes", { skip }, async () => {
  await withIndexer(async ({ indexer, prisma, config }) => {
    const first = await indexer.sync();
    const second = await indexer.sync();

    assert.ok(first.events > 0);
    assert.equal(second.events, 0, "a re-run writes nothing new");

    const checkpoint = await prisma.indexerCheckpoint.findFirst({
      where: { chainId: config.chainId },
    });

    assert.ok(checkpoint.lastIndexedHash, "the cursor still stores a block hash");
    assert.ok(checkpoint.lastSyncCompletedAt, "and a completion timestamp");
  });
});
