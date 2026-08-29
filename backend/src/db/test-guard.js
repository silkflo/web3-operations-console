// backend/src/db/test-guard.js
//
// Refuses to let a test, migration or reset touch anything but a disposable
// local test database.
//
// This exists because a test rebuild once wiped the development index. Naming
// conventions and documentation did not prevent that; a check that runs before
// every destructive operation does.
//
// Every rule below is deliberately conservative: if the target is ambiguous,
// the answer is no.

/**
 * Loopback hosts, always permitted.
 *
 * These resolve to the local machine by definition, so no opt-in is needed.
 */
const ALWAYS_ALLOWED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  // Node's URL parser keeps the brackets on an IPv6 literal.
  "[::1]",
]);

/**
 * The Docker Compose service name.
 *
 * Unlike the loopback hosts this is a NAME, not an address: whatever it
 * resolves to depends on DNS, /etc/hosts and the container network, none of
 * which this process controls. It is therefore off by default and requires a
 * deliberate double opt-in from an environment that actually knows it is
 * running inside the compose network.
 */
const COMPOSE_HOST = "postgres";

/** Both must hold before COMPOSE_HOST is accepted. */
const COMPOSE_OPT_IN_FLAG = "TEST_DATABASE_ALLOW_COMPOSE_HOST";
const COMPOSE_REQUIRED_NODE_ENV = "test";

/**
 * Whether the compose service name is currently permitted.
 *
 * Requires NODE_ENV=test *and* the explicit flag. Either alone is not enough:
 * the flag says "this environment knows about the compose network", NODE_ENV
 * says "this is a test run", and the host is only safe when both are true.
 */
const isComposeHostAllowed = (env = process.env) =>
  env.NODE_ENV === COMPOSE_REQUIRED_NODE_ENV &&
  env[COMPOSE_OPT_IN_FLAG] === "true";

/** Every host permitted right now, given the environment. */
const allowedHosts = (env = process.env) =>
  new Set(
    isComposeHostAllowed(env)
      ? [...ALWAYS_ALLOWED_HOSTS, COMPOSE_HOST]
      : [...ALWAYS_ALLOWED_HOSTS]
  );

/** Substring a test database name must contain. */
const REQUIRED_NAME_MARKER = "_test";

class UnsafeTestDatabaseError extends Error {
  constructor(message) {
    super(
      `Refusing to run against this database.\n\n${message}\n\n` +
        `Tests may only touch a disposable local database whose name contains ` +
        `"${REQUIRED_NAME_MARKER}". See backend/.env.example and DEPLOYMENT.md.`
    );
    this.name = "UnsafeTestDatabaseError";
  }
}

/**
 * Parses a PostgreSQL connection string.
 * Returns null rather than throwing, so the caller reports one clear reason.
 */
const parseDatabaseUrl = (url) => {
  if (!url || typeof url !== "string") {
    return null;
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    return null;
  }

  return {
    host: parsed.hostname,
    port: parsed.port,
    // Strip the leading slash; ignore any query string.
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
};

/**
 * Validates that `testUrl` points at an isolated, disposable test database.
 *
 * @param {Object} input
 * @param {string} [input.testUrl]  DATABASE_URL_TEST.
 * @param {string} [input.devUrl]   DATABASE_URL, for the identity comparison.
 * @param {boolean} [input.requireDistinctFromDev=true]
 * @param {Object} [input.env=process.env]  Injected so the compose-host opt-in
 *                                          can be tested without mutating the
 *                                          real environment.
 * @returns {{host:string, port:string, database:string, url:string}}
 * @throws {UnsafeTestDatabaseError}
 */
const assertTestDatabase = ({
  testUrl,
  devUrl,
  requireDistinctFromDev = true,
  env = process.env,
} = {}) => {
  // 1. It must exist. No silent fallback to DATABASE_URL — that fallback is
  //    exactly how a test run reaches the development database.
  if (!testUrl || String(testUrl).trim() === "") {
    throw new UnsafeTestDatabaseError(
      "DATABASE_URL_TEST is not set.\n" +
        "Tests never fall back to DATABASE_URL, because that is how a test run " +
        "ends up rebuilding your development index."
    );
  }

  const test = parseDatabaseUrl(testUrl);

  if (!test) {
    throw new UnsafeTestDatabaseError(
      "DATABASE_URL_TEST is not a valid postgresql:// connection string."
    );
  }

  // 2. It must not be the development database.
  if (requireDistinctFromDev) {
    if (!devUrl || String(devUrl).trim() === "") {
      throw new UnsafeTestDatabaseError(
        "DATABASE_URL is not set, so DATABASE_URL_TEST cannot be compared " +
          "against it. Set both, or pass requireDistinctFromDev: false when " +
          "no development database exists."
      );
    }

    if (String(testUrl).trim() === String(devUrl).trim()) {
      throw new UnsafeTestDatabaseError(
        "DATABASE_URL_TEST is identical to DATABASE_URL.\n" +
          "The test database must be a separate, disposable database."
      );
    }

    const dev = parseDatabaseUrl(devUrl);

    // Same host, port and database name is the same database even if the
    // credentials in the two strings differ.
    if (
      dev &&
      dev.host === test.host &&
      dev.port === test.port &&
      dev.database === test.database
    ) {
      throw new UnsafeTestDatabaseError(
        `DATABASE_URL_TEST resolves to the same database as DATABASE_URL ` +
          `(${test.host}:${test.port}/${test.database}), only with different ` +
          `connection parameters.`
      );
    }
  }

  // 3. The name must mark it as disposable.
  if (!test.database.includes(REQUIRED_NAME_MARKER)) {
    throw new UnsafeTestDatabaseError(
      `The test database is named "${test.database}", which does not contain ` +
        `"${REQUIRED_NAME_MARKER}".\n` +
        "This guard will not run destructive operations against a database " +
        "that is not explicitly marked as a test database."
    );
  }

  // 4. It must be local.
  const permitted = allowedHosts(env);

  if (!permitted.has(test.host)) {
    // The compose host gets its own message: "not approved" would be
    // misleading when the host is recognised but the opt-in is missing.
    if (test.host === COMPOSE_HOST) {
      const missing = [];

      if (env.NODE_ENV !== COMPOSE_REQUIRED_NODE_ENV) {
        missing.push(
          `NODE_ENV is "${env.NODE_ENV || "unset"}", not "${COMPOSE_REQUIRED_NODE_ENV}"`
        );
      }

      if (env[COMPOSE_OPT_IN_FLAG] !== "true") {
        missing.push(
          `${COMPOSE_OPT_IN_FLAG} is "${env[COMPOSE_OPT_IN_FLAG] || "unset"}", not "true"`
        );
      }

      throw new UnsafeTestDatabaseError(
        `The test database host is the Docker Compose service name ` +
          `"${COMPOSE_HOST}", which is not allowed by default.\n` +
          `It is a hostname rather than an address, so what it resolves to ` +
          `depends on the container network.\n\n` +
          `Blocked because: ${missing.join("; ")}.\n\n` +
          `Allow it only from an explicit Docker/CI test environment that ` +
          `knows the compose network, by setting BOTH:\n` +
          `  NODE_ENV=${COMPOSE_REQUIRED_NODE_ENV}\n` +
          `  ${COMPOSE_OPT_IN_FLAG}=true`
      );
    }

    throw new UnsafeTestDatabaseError(
      `The test database host is "${test.host}", which is not an approved ` +
        `local host.\n` +
        `Approved: ${[...permitted].join(", ")}.\n` +
        "Tests must never run against a remote or production database."
    );
  }

  return { ...test, url: testUrl };
};

/**
 * Guards a destructive operation against a specific target.
 *
 * Used by anything that truncates, resets or rebuilds, so the check sits at the
 * operation rather than only at process start.
 */
const assertSafeDestructiveTarget = (targetUrl, { devUrl, env = process.env } = {}) => {
  const target = parseDatabaseUrl(targetUrl);

  if (!target) {
    throw new UnsafeTestDatabaseError(
      "The destructive operation has no valid target database URL."
    );
  }

  if (devUrl) {
    const dev = parseDatabaseUrl(devUrl);

    if (
      dev &&
      dev.host === target.host &&
      dev.port === target.port &&
      dev.database === target.database
    ) {
      throw new UnsafeTestDatabaseError(
        `Blocked a destructive operation aimed at the DEVELOPMENT database ` +
          `(${target.host}:${target.port}/${target.database}).\n` +
          "Destructive test operations may only target the test database."
      );
    }
  }

  return assertTestDatabase({
    testUrl: targetUrl,
    devUrl,
    requireDistinctFromDev: Boolean(devUrl),
    env,
  });
};

/** Reads and validates the test target from the environment. */
const resolveTestDatabaseUrl = (env = process.env) =>
  assertTestDatabase({
    testUrl: env.DATABASE_URL_TEST,
    devUrl: env.DATABASE_URL,
    env,
  });

module.exports = {
  ALWAYS_ALLOWED_HOSTS,
  COMPOSE_HOST,
  COMPOSE_OPT_IN_FLAG,
  COMPOSE_REQUIRED_NODE_ENV,
  allowedHosts,
  isComposeHostAllowed,
  REQUIRED_NAME_MARKER,
  UnsafeTestDatabaseError,
  parseDatabaseUrl,
  assertTestDatabase,
  assertSafeDestructiveTarget,
  resolveTestDatabaseUrl,
};
