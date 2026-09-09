// backend/test/guard.test.js
//
// Regression tests for the test-database safety guard.
//
// These are the checks that stand between a test run and the development
// index. They are pure — no database connection — so they run everywhere and
// cannot themselves be the thing that breaks.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// The guard's rules are pure, but two tests below assert that the COMMITTED
// configuration satisfies them, which needs the real environment loaded.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  assertTestDatabase,
  assertSafeDestructiveTarget,
  parseDatabaseUrl,
  resolveTestDatabaseUrl,
  UnsafeTestDatabaseError,
  ALWAYS_ALLOWED_HOSTS,
  COMPOSE_HOST,
  COMPOSE_OPT_IN_FLAG,
  COMPOSE_REQUIRED_NODE_ENV,
  allowedHosts,
  isComposeHostAllowed,
  REQUIRED_NAME_MARKER,
} = require("../src/db/test-guard");
const { skipReason } = require("./helpers/test-db");

// The rules themselves are pure, but the one test that checks the REAL
// configured environment needs a configured test database. Same guard as
// every other database-dependent test in this suite.
const skip = skipReason();

const DEV = "postgresql://web3:pw@127.0.0.1:55432/web3_index_dev";
const TEST = "postgresql://web3:pw@127.0.0.1:55432/web3_index_test";

/** Asserts the call is blocked and that the reason is stated. */
const expectBlocked = (fn, expectedReason) => {
  assert.throws(
    fn,
    (error) => {
      assert.ok(
        error instanceof UnsafeTestDatabaseError,
        `expected UnsafeTestDatabaseError, got ${error.name}`
      );
      assert.match(
        error.message,
        expectedReason,
        `error must explain why it blocked; got:\n${error.message}`
      );
      assert.match(
        error.message,
        /Refusing to run against this database/,
        "error must say plainly that it refused"
      );
      return true;
    }
  );
};

// ---------------------------------------------------------------- parsing ----

test("parses a postgres URL into host, port and database", () => {
  assert.deepEqual(parseDatabaseUrl(TEST), {
    host: "127.0.0.1",
    port: "55432",
    database: "web3_index_test",
  });
});

test("rejects non-postgres and malformed URLs", () => {
  assert.equal(parseDatabaseUrl("mysql://x/y_test"), null);
  assert.equal(parseDatabaseUrl("not a url"), null);
  assert.equal(parseDatabaseUrl(""), null);
  assert.equal(parseDatabaseUrl(undefined), null);
});

// ------------------------------------------------------- required case 1 ----

test("case 1: blocks a missing DATABASE_URL_TEST", () => {
  expectBlocked(
    () => assertTestDatabase({ testUrl: undefined, devUrl: DEV }),
    /DATABASE_URL_TEST is not set/
  );
});

test("case 1: blocks an empty DATABASE_URL_TEST", () => {
  expectBlocked(
    () => assertTestDatabase({ testUrl: "   ", devUrl: DEV }),
    /DATABASE_URL_TEST is not set/
  );
});

test("case 1: never silently falls back to DATABASE_URL", () => {
  // The whole point: absence must fail, not default to development.
  expectBlocked(
    () => assertTestDatabase({ testUrl: null, devUrl: DEV }),
    /never fall back to DATABASE_URL/
  );
});

// ------------------------------------------------------- required case 2 ----

test("case 2: blocks identical development and test URLs", () => {
  expectBlocked(
    () => assertTestDatabase({ testUrl: DEV, devUrl: DEV }),
    /identical to DATABASE_URL/
  );
});

test("case 2: blocks the same database reached with different credentials", () => {
  // Different user and password, same host/port/database — still the same data.
  const disguised = "postgresql://other:other@127.0.0.1:55432/web3_index_dev";

  expectBlocked(
    () => assertTestDatabase({ testUrl: disguised, devUrl: DEV }),
    /same database as DATABASE_URL/
  );
});

test("case 2: blocks when DATABASE_URL is absent and comparison is required", () => {
  expectBlocked(
    () => assertTestDatabase({ testUrl: TEST, devUrl: undefined }),
    /DATABASE_URL is not set/
  );
});

// ------------------------------------------------------- required case 3 ----

test("case 3: blocks a database name without _test", () => {
  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: "postgresql://web3:pw@127.0.0.1:55432/web3_scratch",
        devUrl: DEV,
      }),
    /does not contain/
  );
});

test("case 3: names the marker it requires", () => {
  try {
    assertTestDatabase({
      testUrl: "postgresql://web3:pw@127.0.0.1:55432/anything",
      devUrl: DEV,
    });
    assert.fail("should have thrown");
  } catch (error) {
    assert.match(error.message, new RegExp(REQUIRED_NAME_MARKER));
  }
});

test("case 3: accepts any name containing the marker", () => {
  ["web3_index_test", "my_test_db", "test_scratch_test"].forEach((name) => {
    const url = `postgresql://web3:pw@127.0.0.1:55432/${name}`;
    assert.equal(assertTestDatabase({ testUrl: url, devUrl: DEV }).database, name);
  });
});

// ------------------------------------------------------- required case 4 ----

test("case 4: blocks a remote host", () => {
  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: "postgresql://web3:pw@db.production.example.com:5432/web3_index_test",
        devUrl: DEV,
      }),
    /not an approved local host/
  );
});

test("case 4: blocks a public IP even with a _test name", () => {
  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: "postgresql://web3:pw@203.0.113.10:5432/web3_index_test",
        devUrl: DEV,
      }),
    /not an approved local host/
  );
});

test("case 4: allows the loopback hosts with no opt-in", () => {
  ALWAYS_ALLOWED_HOSTS.forEach((host) => {
    // Bracket the IPv6 literal so the URL parser accepts it.
    const authority = host === "::1" ? "[::1]" : host;
    const url = `postgresql://web3:pw@${authority}:55432/web3_index_test`;

    assert.doesNotThrow(
      () => assertTestDatabase({ testUrl: url, devUrl: DEV, env: {} }),
      `${host} should be approved without any opt-in`
    );
  });
});

test("case 4: a cloud provider host is refused", () => {
  [
    "postgresql://u:p@ep-cool-name.eu-central-1.aws.neon.tech/web3_index_test",
    "postgresql://u:p@db.abcdefg.supabase.co:5432/web3_index_test",
    "postgresql://u:p@my-rds.eu-west-1.rds.amazonaws.com:5432/web3_index_test",
  ].forEach((url) => {
    expectBlocked(
      () => assertTestDatabase({ testUrl: url, devUrl: DEV }),
      /not an approved local host/
    );
  });
});

// ------------------------------- compose host: blocked unless opted in ----

const COMPOSE_URL = `postgresql://web3:pw@${COMPOSE_HOST}:5432/web3_index_test`;

const OPTED_IN = {
  NODE_ENV: COMPOSE_REQUIRED_NODE_ENV,
  [COMPOSE_OPT_IN_FLAG]: "true",
};

test("compose host is blocked by default", () => {
  expectBlocked(
    () => assertTestDatabase({ testUrl: COMPOSE_URL, devUrl: DEV, env: {} }),
    /not allowed by default/
  );
});

test("compose host is blocked in a normal local dev environment", () => {
  // The committed .env sets neither, which is the point: the flag must never
  // be a local default.
  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: COMPOSE_URL,
        devUrl: DEV,
        env: { NODE_ENV: "development" },
      }),
    /not allowed by default/
  );
});

test("compose host needs the flag as well as NODE_ENV=test", () => {
  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: COMPOSE_URL,
        devUrl: DEV,
        env: { NODE_ENV: "test" },
      }),
    new RegExp(`${COMPOSE_OPT_IN_FLAG} is "unset"`)
  );
});

test("compose host needs NODE_ENV=test as well as the flag", () => {
  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: COMPOSE_URL,
        devUrl: DEV,
        env: { [COMPOSE_OPT_IN_FLAG]: "true" },
      }),
    /NODE_ENV is "unset", not "test"/
  );
});

test("compose host rejects a flag value that is not exactly true", () => {
  ["TRUE", "1", "yes", "", "false"].forEach((value) => {
    expectBlocked(
      () =>
        assertTestDatabase({
          testUrl: COMPOSE_URL,
          devUrl: DEV,
          env: { NODE_ENV: "test", [COMPOSE_OPT_IN_FLAG]: value },
        }),
      /not allowed by default/
    );
  });
});

test("compose host is allowed with BOTH NODE_ENV=test and the flag", () => {
  const target = assertTestDatabase({
    testUrl: COMPOSE_URL,
    devUrl: DEV,
    env: OPTED_IN,
  });

  assert.equal(target.host, COMPOSE_HOST);
  assert.equal(target.database, "web3_index_test");
});

test("the opt-in relaxes only the host, never the other rules", () => {
  // A compose-hosted database still needs a _test name and must differ from
  // development.
  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: `postgresql://web3:pw@${COMPOSE_HOST}:5432/web3_index_dev`,
        devUrl: DEV,
        env: OPTED_IN,
      }),
    /does not contain/
  );

  expectBlocked(
    () =>
      assertTestDatabase({
        testUrl: `postgresql://web3:pw@remote.example.com:5432/web3_index_test`,
        devUrl: DEV,
        env: OPTED_IN,
      }),
    /not an approved local host/
  );
});

test("isComposeHostAllowed reflects the double opt-in", () => {
  assert.equal(isComposeHostAllowed({}), false);
  assert.equal(isComposeHostAllowed({ NODE_ENV: "test" }), false);
  assert.equal(
    isComposeHostAllowed({ [COMPOSE_OPT_IN_FLAG]: "true" }),
    false
  );
  assert.equal(isComposeHostAllowed(OPTED_IN), true);
});

test("allowedHosts adds the compose host only when opted in", () => {
  assert.equal(allowedHosts({}).has(COMPOSE_HOST), false);
  assert.equal(allowedHosts(OPTED_IN).has(COMPOSE_HOST), true);

  // Loopback is present either way.
  ["localhost", "127.0.0.1"].forEach((host) => {
    assert.equal(allowedHosts({}).has(host), true);
    assert.equal(allowedHosts(OPTED_IN).has(host), true);
  });
});

test("the committed .env does not enable the compose opt-in", () => {
  // Regression guard: the flag must never become a local default. Only
  // uncommented lines count, so documenting it in a comment stays allowed.
  const fs = require("fs");

  const flagPattern = new RegExp(`^${COMPOSE_OPT_IN_FLAG}\s*=\s*true$`);

  const enablesFlag = (contents) =>
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .some((line) => flagPattern.test(line));

  const envPath = path.join(__dirname, "..", ".env");

  if (fs.existsSync(envPath)) {
    assert.equal(
      enablesFlag(fs.readFileSync(envPath, "utf8")),
      false,
      `${COMPOSE_OPT_IN_FLAG}=true must not be active in backend/.env`
    );
  }

  assert.equal(
    enablesFlag(
      fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8")
    ),
    false,
    `${COMPOSE_OPT_IN_FLAG}=true must not be a default in .env.example`
  );
});

// ------------------------------------------------------- required case 5 ----

test("case 5: blocks a destructive operation aimed at the development database", () => {
  expectBlocked(
    () => assertSafeDestructiveTarget(DEV, { devUrl: DEV }),
    /Blocked a destructive operation aimed at the DEVELOPMENT database/
  );
});

test("case 5: blocks it even when the dev URL uses different credentials", () => {
  expectBlocked(
    () =>
      assertSafeDestructiveTarget(
        "postgresql://root:secret@127.0.0.1:55432/web3_index_dev",
        { devUrl: DEV }
      ),
    /DEVELOPMENT database/
  );
});

test("case 5: permits a destructive operation on the test database", () => {
  assert.doesNotThrow(() => assertSafeDestructiveTarget(TEST, { devUrl: DEV }));
});

test("case 5: refuses a destructive operation with no target at all", () => {
  expectBlocked(
    () => assertSafeDestructiveTarget(undefined, { devUrl: DEV }),
    /no valid target database URL/
  );
});

// ------------------------------------------------------------ happy path ----

test("accepts a properly isolated local test database", () => {
  const target = assertTestDatabase({ testUrl: TEST, devUrl: DEV });

  assert.equal(target.database, "web3_index_test");
  assert.equal(target.host, "127.0.0.1");
  assert.equal(target.url, TEST);
});

test("resolves the real configured environment safely", { skip }, () => {
  // The committed configuration must itself satisfy every rule.
  const target = resolveTestDatabaseUrl();

  assert.match(target.database, /_test/);
  assert.ok(allowedHosts(process.env).has(target.host));
  assert.notEqual(target.url, process.env.DATABASE_URL);
});

// ----------------------------------------------------- wiring is enforced ----

test("the test helper never connects without the guard", () => {
  const fs = require("fs");
  const helper = fs.readFileSync(
    path.join(__dirname, "helpers", "test-db.js"),
    "utf8"
  );

  assert.match(helper, /resolveTestDatabaseUrl/);
  assert.match(
    helper,
    /datasources: \{ db: \{ url: target\.url \} \}/,
    "clients must be pinned to the test URL by explicit datasource override"
  );
  assert.match(
    helper,
    /assertSafeDestructiveTarget/,
    "truncation must re-check its target"
  );
});

test("the Prisma test runner guards before spawning Prisma", () => {
  const fs = require("fs");
  const runner = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "db-test.js"),
    "utf8"
  );

  const guardAt = runner.indexOf("assertSafeDestructiveTarget(");
  const spawnAt = runner.indexOf("spawnSync(");

  assert.ok(guardAt > 0, "runner must call the guard");
  assert.ok(spawnAt > 0, "runner must spawn prisma");
  assert.ok(
    guardAt < spawnAt,
    "the guard must run before Prisma is spawned, not after"
  );
  assert.match(
    runner,
    /DATABASE_URL: process\.env\.DATABASE_URL_TEST/,
    "runner must override DATABASE_URL for the child process"
  );
});

test("no test file connects through the production db client", () => {
  const fs = require("fs");

  fs.readdirSync(__dirname)
    .filter((name) => name.endsWith(".test.js"))
    .forEach((name) => {
      const source = fs.readFileSync(path.join(__dirname, name), "utf8");

      assert.ok(
        !/require\(["']\.\.\/src\/db\/client["']\)/.test(source) ||
          /helpers\/test-db/.test(source),
        `${name} must obtain its client from helpers/test-db.js`
      );
    });
});
