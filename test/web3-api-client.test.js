// test/web3-api-client.test.js
//
// The browser's request pattern, and the honesty of what it reports.
//
// The console used to make three concurrent requests per refresh. It now makes
// one, against `/api/v1/web3/dashboard`, and falls back to the old three only
// against a backend that predates that route — so a frontend deployed ahead of
// its API degrades to the previous behaviour instead of rendering nothing.

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("fs");
const path = require("path");

const {
  createWeb3ApiClient,
  describeFreshness,
  describeDataState,
  combineLegacyPayloads,
  Web3ApiError,
  NOT_CONFIGURED,
} = require("../lib/web3-api-client");

const BASE = "https://web3-api.test.invalid";

/** Records every request and answers from a path -> handler table. */
const withStubbedFetch = async (routes, fn) => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.NEXT_PUBLIC_WEB3_API_URL;
  const requests = [];

  process.env.NEXT_PUBLIC_WEB3_API_URL = BASE;

  globalThis.fetch = async (url) => {
    const path = String(url).slice(BASE.length);
    requests.push(path);

    const handler = routes[path];

    if (!handler) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ message: `No route for ${path}`, statusCode: 404 }),
      };
    }

    return handler();
  };

  try {
    return await fn({ requests });
  } finally {
    globalThis.fetch = originalFetch;

    if (originalBase === undefined) {
      delete process.env.NEXT_PUBLIC_WEB3_API_URL;
    } else {
      process.env.NEXT_PUBLIC_WEB3_API_URL = originalBase;
    }
  }
};

const ok = (body) => () => ({ ok: true, status: 200, json: async () => body });

const DASHBOARD_BODY = {
  generatedAtBlock: 11586719,
  splits: [{ address: "0xabc", title: "Creator Revenue Share" }],
  warnings: [],
  freshness: { state: "fresh", source: "live", servedFromCache: false },
  summary: { factory: { address: "0xfac", version: "3.0.0" } },
  health: { status: "ok", database: "up", rpc: "up" },
};

test("one dashboard request replaces the three-endpoint fan-out", async () => {
  await withStubbedFetch(
    { "/api/v1/web3/dashboard": ok(DASHBOARD_BODY) },
    async ({ requests }) => {
      const api = createWeb3ApiClient();
      const payload = await api.dashboard();

      assert.deepEqual(requests, ["/api/v1/web3/dashboard"]);
      assert.equal(payload.generatedAtBlock, DASHBOARD_BODY.generatedAtBlock);
      assert.equal(payload.health.rpc, "up");
      assert.equal(payload.summary.factory.version, "3.0.0");
    }
  );
});

test("an older backend falls back to the legacy endpoints, once", async () => {
  await withStubbedFetch(
    {
      "/health": ok({ status: "ok", database: "up" }),
      "/api/v1/web3/splits": ok({
        generatedAtBlock: 42,
        splits: [{ address: "0xabc" }],
        warnings: ["heads up"],
      }),
      "/api/v1/web3/summary": ok({ factory: { address: "0xfac" } }),
    },
    async ({ requests }) => {
      const api = createWeb3ApiClient();

      const first = await api.dashboard();

      assert.equal(first.legacy, true);
      assert.equal(first.generatedAtBlock, 42);
      assert.deepEqual(first.warnings, ["heads up"]);
      assert.equal(api.supportsDashboard(), false);

      requests.length = 0;
      await api.dashboard();

      assert.ok(
        !requests.includes("/api/v1/web3/dashboard"),
        "the missing route is not probed again"
      );
      assert.equal(requests.length, 3, "exactly the three legacy calls");
    }
  );
});

test("a non-404 dashboard failure is reported, not silently downgraded", async () => {
  await withStubbedFetch(
    {
      "/api/v1/web3/dashboard": () => ({
        ok: false,
        status: 503,
        json: async () => ({ message: "Service Unavailable", statusCode: 503 }),
      }),
    },
    async () => {
      const api = createWeb3ApiClient();

      await assert.rejects(() => api.dashboard(), Web3ApiError);
      assert.equal(
        api.supportsDashboard(),
        true,
        "a 503 says nothing about whether the route exists"
      );
    }
  );
});

test("an optional legacy call failing does not lose the rest", () => {
  const combined = combineLegacyPayloads({
    health: null,
    splits: { generatedAtBlock: 7, splits: [{ address: "0xabc" }] },
    summary: null,
  });

  assert.equal(combined.generatedAtBlock, 7);
  assert.equal(combined.splits.length, 1);
  assert.equal(combined.summary, null);
  assert.deepEqual(combined.warnings, []);
});

test("an unconfigured deployment says so instead of throwing a network error", async () => {
  const original = process.env.NEXT_PUBLIC_WEB3_API_URL;
  delete process.env.NEXT_PUBLIC_WEB3_API_URL;

  try {
    const api = createWeb3ApiClient();

    assert.equal(api.isConfigured(), false);
    await assert.rejects(() => api.dashboard(), (error) => {
      assert.equal(error.message, NOT_CONFIGURED);
      return true;
    });
  } finally {
    if (original !== undefined) {
      process.env.NEXT_PUBLIC_WEB3_API_URL = original;
    }
  }
});

// ------------------------------------------------------------- honesty ----

test("cached, degraded and stale data are never presented as live", () => {
  const stale = describeFreshness({
    database: "up",
    rpc: "up",
    servingStaleData: true,
    stale: false,
  });

  assert.equal(stale.level, "stale");
  assert.match(stale.detail, /not current live-chain values/i);

  const rpcDown = describeFreshness({ database: "up", rpc: "down", stale: false });

  assert.equal(rpcDown.level, "stale");
  assert.match(rpcDown.detail, /from the index/i);

  const healthy = describeFreshness({
    database: "up",
    rpc: "up",
    stale: false,
    indexerLagBlocks: 4,
  });

  assert.equal(healthy.level, "fresh");
});

test("a stale index is still reported when the RPC is fine", () => {
  const freshness = describeFreshness({
    database: "up",
    rpc: "up",
    stale: true,
    indexerLagBlocks: 12500,
  });

  assert.equal(freshness.level, "stale");
  assert.match(freshness.detail, /12500 blocks behind/);
});

test("a database outage outranks everything else", () => {
  const freshness = describeFreshness({
    database: "down",
    rpc: "up",
    servingStaleData: true,
  });

  assert.equal(freshness.level, "error");
});

// ------------------------------------------- degraded is never "live" ----

const dashboardPayload = (freshness, health = { rpc: "up" }) => ({
  generatedAtBlock: 100,
  splits: [],
  warnings: [],
  freshness,
  health,
});

const coverage = (live, lastKnownGood, derived) => ({
  live,
  lastKnownGood,
  derived,
  total: live + lastKnownGood + derived,
});

test("a fully live payload is classified live", () => {
  const state = describeDataState(
    dashboardPayload({
      source: "live",
      degraded: false,
      stale: false,
      currentState: coverage(3, 0, 0),
    })
  );

  assert.equal(state.isLive, true);
  assert.equal(state.level, "live");
});

test("a degraded dashboard response is never classified as live", () => {
  // The defect this pins: the page called setNetworkStatus("live") on any
  // successful HTTP response, so an API answering perfectly with zero working
  // contract reads was rendered as "Live".
  const degradedShapes = [
    {
      name: "every read failed",
      freshness: {
        source: "index",
        degraded: true,
        stale: false,
        currentState: coverage(0, 0, 3),
      },
      health: { rpc: "degraded" },
    },
    {
      name: "partial read failure",
      freshness: {
        source: "mixed",
        degraded: true,
        stale: false,
        currentState: coverage(2, 0, 1),
      },
      health: { rpc: "degraded" },
    },
    {
      name: "serving last known good",
      freshness: {
        source: "last-known-good",
        degraded: true,
        stale: false,
        currentState: coverage(0, 3, 0),
      },
      health: { rpc: "degraded" },
    },
    {
      name: "stale snapshot",
      freshness: {
        source: "live",
        degraded: true,
        stale: true,
        currentState: coverage(3, 0, 0),
      },
      health: { rpc: "up" },
    },
    {
      name: "freshness says live but health says the RPC is down",
      freshness: {
        source: "live",
        degraded: false,
        stale: false,
        currentState: coverage(3, 0, 0),
      },
      health: { rpc: "down" },
    },
  ];

  degradedShapes.forEach(({ name, freshness, health }) => {
    const state = describeDataState(dashboardPayload(freshness, health));

    assert.equal(state.isLive, false, `${name} must not be classified live`);
    assert.notEqual(state.label, "Live", `${name} must not be labelled "Live"`);
    assert.ok(state.detail, `${name} must explain itself`);
  });
});

test("a partial failure is counted rather than rounded off", () => {
  const state = describeDataState(
    dashboardPayload({
      source: "mixed",
      degraded: true,
      stale: false,
      currentState: coverage(2, 1, 0),
    })
  );

  assert.equal(state.label, "Partly live");
  assert.match(state.detail, /2 of 3 contracts read live/);
  assert.match(state.detail, /1 from an earlier read/);
});

test("a payload with no freshness block is not assumed live", () => {
  // An older backend, or the legacy fallback path. Absence of evidence is not
  // evidence of liveness.
  assert.equal(describeDataState(dashboardPayload(null)).isLive, false);
  assert.equal(describeDataState(null).isLive, false);
  assert.equal(describeDataState({}).isLive, false);
});

// -------------------------------------- the page must not overclaim ----

/**
 * Source-level guards on pages/index.js.
 *
 * The copy on the page states things about the data ("Live Blockchain Data",
 * "Read live from Sepolia", "Indexed events + live contract reads"). Each is
 * true only when the reads actually succeeded, so each must sit behind the
 * liveness flag rather than being printed unconditionally.
 */
const pageSource = () =>
  fs.readFileSync(path.join(__dirname, "..", "pages", "index.js"), "utf8");

test("the page never hard-codes a live claim about the data", () => {
  const source = pageSource();

  assert.ok(
    !/setNetworkStatus\("live"\)/.test(source),
    "a successful HTTP response must not be treated as live data"
  );

  [
    ["Live Blockchain Data", /isLiveData\s*\?\s*"Live Blockchain Data"/],
    ["Read live from Sepolia", /isLiveData\s*\n?\s*\?\s*"Read live from Sepolia\./],
    [
      "Indexed events + live contract reads",
      /isLiveData\s*\n?\s*\?\s*"Indexed events \+ live contract reads"/,
    ],
  ].forEach(([claim, guarded]) => {
    assert.ok(
      source.includes(claim),
      `${claim} should still exist as the live-case copy`
    );
    assert.match(
      source,
      guarded,
      `"${claim}" must be conditional on live data, not stated unconditionally`
    );
  });
});

test("the page derives its liveness from the payload, not from the request", () => {
  const source = pageSource();

  assert.match(source, /describeDataState/, "uses the shared classifier");
  assert.match(
    source,
    /const isLiveData = dataState\.isLive/,
    "liveness comes from the classifier"
  );
  assert.match(
    source,
    /networkStatus !== "degraded"/,
    "a failed refresh must also disqualify the live claim"
  );
});
