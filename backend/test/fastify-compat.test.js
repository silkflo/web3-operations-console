// backend/test/fastify-compat.test.js
//
// Regression tests for the Fastify 4 -> 5 upgrade.
//
// The upgrade closed two high-severity advisories, one of which
// (GHSA-444r-cwp2-x5xf) is specifically about request.protocol / request.host
// being spoofable through X-Forwarded-* headers when a proxy is trusted. This
// API sets `trustProxy` and keys its rate limiter on the derived client IP, so
// that derivation is pinned here rather than left implicit.
//
// The rest pins the plugin-major behaviours that a v9 -> v11 jump could have
// changed silently: the function-form CORS origin check, and the rate limiter's
// keyGenerator and allowList.

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildApp } = require("../src/api/app");
const { createIndexer } = require("../src/indexer/indexer");
const { createStubChain, stubConfig } = require("./fixtures/chain");
const { createTestPrisma, truncateAll, skipReason } = require("./helpers/test-db");

const skip = skipReason();

/** Minimum framework version carrying the two advisory fixes. */
const MIN_FASTIFY_MAJOR = 5;

const withApp = async (fn, { seed = false } = {}) => {
  const prisma = createTestPrisma();
  const chain = createStubChain();
  const config = stubConfig();

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

    const app = await buildApp({
      runtime: { config, prisma, provider: null, reader: chain.reader, indexer: null },
      logger: false,
    });

    try {
      await fn(app, config);
    } finally {
      await app.close();
    }
  } finally {
    await prisma.$disconnect();
  }
};

// ------------------------------------------------------------- versions ----

test("runs on a Fastify major that carries the advisory fixes", () => {
  const version = require("fastify/package.json").version;
  const major = Number.parseInt(version.split(".")[0], 10);

  assert.ok(
    major >= MIN_FASTIFY_MAJOR,
    `fastify ${version} is older than the patched ${MIN_FASTIFY_MAJOR}.x line`
  );
});

test("bundles a find-my-way past the HTTP/2 DoS advisory", () => {
  // GHSA-c96f-x56v-gq3h affects find-my-way <= 9.6.0. It is a transitive
  // dependency of fastify, so it is asserted through fastify's own resolution.
  const resolved = require.resolve("find-my-way/package.json", {
    paths: [require.resolve("fastify")],
  });
  const version = require(resolved).version;
  const [major, minor] = version.split(".").map(Number);

  assert.ok(
    major > 9 || (major === 9 && minor > 6),
    `find-my-way ${version} is within the vulnerable range (<= 9.6.0)`
  );
});

test("every Fastify plugin is on a Fastify 5 generation", () => {
  // fastify-plugin 6 is the Fastify 5 generation; 5 targets Fastify 4. A plugin
  // still on fastify-plugin 5 would be a silent compatibility mismatch.
  ["@fastify/cors", "@fastify/rate-limit", "@fastify/sensible"].forEach((name) => {
    const resolved = require.resolve("fastify-plugin/package.json", {
      paths: [require.resolve(`${name}/package.json`)],
    });

    const major = Number.parseInt(require(resolved).version.split(".")[0], 10);

    assert.ok(major >= 6, `${name} resolves fastify-plugin ${major}.x, expected >= 6`);
  });
});

// -------------------------------------------------- trust proxy behaviour ----

test("derives the client IP from X-Forwarded-For with trustProxy on", { skip }, async () => {
  await withApp(async (app) => {
    app.get("/__test/ip", async (request) => ({
      ip: request.ip,
      protocol: request.protocol,
      host: request.host,
    }));

    const forwarded = await app.inject({
      method: "GET",
      url: "/__test/ip",
      headers: {
        "x-forwarded-for": "198.51.100.7",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.example.com",
      },
    });

    const body = forwarded.json();

    // This is what the rate limiter keys on behind Nginx. If it regressed to
    // the proxy's own address, every visitor would share one bucket.
    assert.equal(body.ip, "198.51.100.7");
    assert.equal(body.protocol, "https");
    assert.equal(body.host, "api.example.com");
  });
});

test("falls back to the socket address when no proxy headers are sent", { skip }, async () => {
  await withApp(async (app) => {
    app.get("/__test/ip", async (request) => ({
      ip: request.ip,
      protocol: request.protocol,
    }));

    const direct = await app.inject({ method: "GET", url: "/__test/ip" });
    const body = direct.json();

    assert.equal(body.ip, "127.0.0.1");
    assert.equal(body.protocol, "http", "no X-Forwarded-Proto means plain http");
  });
});

test("keeps trustProxy enabled for the Nginx deployment", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "api", "app.js"),
    "utf8"
  );

    assert.ok(
    source.includes('trustProxy: ["127.0.0.1", "::1"]'),
    "only the local Nginx proxy may be trusted"
  );
});

test("sets no deprecated Fastify 4 options", () => {
  // disableRequestLogging is deprecated in 5 (FSTDEP023) and removed in 6.
  // Its default is false, which is what this API wants, so it is simply absent.
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "api", "app.js"),
    "utf8"
  );

  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.ok(
    !/disableRequestLogging\s*:/.test(code),
    "disableRequestLogging must not be set; it is deprecated and its default already matches"
  );
});

// ------------------------------------------------- plugin-major behaviour ----

test("function-form CORS origin still allows and denies correctly", { skip }, async () => {
  // @fastify/cors 9 -> 11 kept the (origin, callback) signature. Pinned because
  // a signature change would silently allow every origin.
  await withApp(async (app, config) => {
    const allowed = config.api.corsOrigins[0];

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

    // No Origin header at all (curl, server-to-server) is permitted.
    const none = await app.inject({ method: "GET", url: "/health" });
    assert.equal(none.statusCode, 200);
  });
});

test("CORS still advertises only read methods", { skip }, async () => {
  await withApp(async (app, config) => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/web3/summary",
      headers: {
        origin: config.api.corsOrigins[0],
        "access-control-request-method": "GET",
      },
    });

    const methods = preflight.headers["access-control-allow-methods"] || "";

    assert.match(methods, /GET/);
    ["POST", "PUT", "PATCH", "DELETE"].forEach((verb) => {
      assert.ok(!methods.includes(verb), `${verb} must not be advertised`);
    });
  });
});

test("rate limiter still keys per client IP and exempts health", { skip }, async () => {
  // @fastify/rate-limit 9 -> 11 kept keyGenerator and allowList. If keyGenerator
  // regressed, all clients would share a bucket; if allowList regressed,
  // monitoring could be locked out.
  await withApp(async (app, config) => {
    const max = config.api.rateLimitMax;

    const hit = (ip) =>
      app.inject({
        method: "GET",
        url: "/api/v1/web3/questions",
        headers: { "x-forwarded-for": ip },
      });

    let limited = false;

    for (let i = 0; i < max + 3; i += 1) {
      const res = await hit("203.0.113.11");

      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }

    assert.ok(limited, "the noisy client is limited");

    // A different IP must have its own budget.
    const other = await hit("203.0.113.99");
    assert.notEqual(other.statusCode, 429, "limits are per IP, not global");

    // Health stays reachable for monitoring even from the limited IP.
    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "203.0.113.11" },
    });
    assert.notEqual(health.statusCode, 429);
  });
});

// ------------------------------------------------- contract is unchanged ----

test("response shapes survive the serializer change", { skip }, async () => {
  await withApp(
    async (app) => {
      const splits = (
        await app.inject({ method: "GET", url: "/api/v1/web3/splits" })
      ).json();

      assert.ok(splits.splits.length > 0);

      // Fastify 5 changed its serializer internals; these fields are the public
      // contract the frontend reads.
      [
        "address",
        "title",
        "currentRound",
        "currentParticipantCount",
        "balanceWei",
        "roundPoolWei",
        "totalClaimableWei",
        "lifecycleState",
        "lifecycleExplanation",
        "description",
        "outstandingClaimCount",
        "evidence",
        "rounds",
      ].forEach((key) => {
        assert.ok(key in splits.splits[0], `splits[].${key} must still be sent`);
      });

      // uint256 values must still cross the wire as strings, not numbers.
      assert.equal(typeof splits.splits[0].balanceWei, "string");
    },
    { seed: true }
  );
});

test("schema validation and coercion still reject bad input", { skip }, async () => {
  await withApp(async (app) => {
    const overLimit = await app.inject({
      method: "GET",
      url: "/api/v1/web3/activity?limit=5000",
    });
    assert.equal(overLimit.statusCode, 400);

    const badAddress = await app.inject({
      method: "GET",
      url: "/api/v1/web3/splits/nothex",
    });
    assert.equal(badAddress.statusCode, 400);

    const badQuestion = await app.inject({
      method: "GET",
      url: "/api/v1/web3/intelligence/nope",
    });
    assert.equal(badQuestion.statusCode, 400);
  });
});

test("still exposes no write route after the router upgrade", { skip }, async () => {
  // find-my-way is the router; this upgrade moved it 9.x -> 9.9.0.
  await withApp(async (app) => {
    const routes = app.printRoutes({ commonPrefix: false });

    ["POST", "PUT", "PATCH", "DELETE"].forEach((verb) => {
      assert.ok(!routes.includes(verb), `no ${verb} route may exist`);
    });

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
