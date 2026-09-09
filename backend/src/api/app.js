// backend/src/api/app.js
//
// Read-only, versioned Fastify API.
//
// Hard rules, enforced by tests:
//   - GET only. No route mutates chain or database state.
//   - No signer, wallet, private key or mnemonic is reachable from here.
//   - No participant address appears in any response body.
//   - Raw database errors never reach a client; they are logged with a request
//     id and answered with a generic message.

const Fastify = require("fastify");
const cors = require("@fastify/cors");
const rateLimit = require("@fastify/rate-limit");
const sensible = require("@fastify/sensible");
const helmet = require("@fastify/helmet");

const { registerRoutes } = require("./routes");
const { createSnapshotService } = require("./snapshot");
const { errorSerializer } = require("../util/redact");

/** Serializes BigInt safely: JSON.stringify throws on it by default. */
const bigintSafe = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, inner) =>
      typeof inner === "bigint" ? inner.toString() : inner
    )
  );

/**
 * Pino options for the API logger.
 *
 * Exported so the secret-leak regression test configures a logger exactly the
 * way the running service does, rather than a lookalike that could drift.
 */
const buildLoggerOptions = (config) => ({
  level: config.api.logLevel,
  // Structured logs; never log a full env or connection string.
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    remove: true,
  },
  serializers: {
    // Pino's default would log err.message and err.stack verbatim. Ethers puts
    // the credential-bearing RPC URL in both, so one 429 would write the API
    // key into the journal. This is the safety net under every explicit call
    // site: anything logged as `err` is redacted whether or not the caller
    // remembered to redact it.
    err: errorSerializer,
    error: errorSerializer,
  },
});

const buildApp = async ({ runtime, logger = true } = {}) => {
  const { config } = runtime;

  const app = Fastify({
    logger: logger === false ? false : buildLoggerOptions(config),
    // Correlates every log line and error response with one request.
    genReqId: () =>
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    // `disableRequestLogging: false` was set explicitly under Fastify 4. It is
    // deprecated in Fastify 5 (FSTDEP023) and removed in 6, and false is the
    // framework default, so the option is dropped rather than migrated to
    // `logController` — that would add configuration for no behavioural change.
    // Per-request logging remains ON.
       trustProxy: ["127.0.0.1", "::1"],
  });

  await app.register(sensible);

  // Security response headers. Registered before CORS so the CORS plugin stays
  // the single owner of cross-origin negotiation and helmet only hardens the
  // response.
  await app.register(helmet, {
    // The console frontend reads this API from another subdomain. CORP's
    // same-origin default is aimed at documents and no-cors subresources;
    // cross-origin is the correct policy for a public read-only JSON API and
    // leaves the CORS allow-list above as the only access control.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  await app.register(cors, {
    // Explicit allow-list from the environment. No wildcard.
    origin: (origin, callback) => {
      if (!origin) {
        // Same-origin, curl and server-to-server calls carry no Origin header.
        callback(null, true);
        return;
      }

      callback(null, config.api.corsOrigins.includes(origin));
    },
    methods: ["GET", "OPTIONS"],
    // Public read endpoints need no cookies or auth headers.
    credentials: false,
  });

  await app.register(rateLimit, {
    max: config.api.rateLimitMax,
    timeWindow: config.api.rateLimitWindow,
    // Health must stay reachable for monitoring even under load.
    allowList: (request) => request.url === "/health",
    keyGenerator: (request) => request.ip,
  });

  app.decorate("runtime", runtime);
  app.decorate("bigintSafe", bigintSafe);

  // One snapshot cache per app instance. Built here rather than in
  // createRuntime so tests that override the reader get a matching cache.
  app.decorate(
    "snapshots",
    createSnapshotService({
      runtime,
      logger: logger === false ? { warn() {}, info() {}, error() {} } : app.log,
    })
  );

  // One error shape for everything. The detail goes to the log, not the client.
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

    if (status >= 500) {
      request.log.error(
        { err: error, reqId: request.id },
        "unhandled error serving request"
      );
    } else {
      request.log.warn({ reqId: request.id, msg: error.message }, "request rejected");
    }

    reply.status(status).send({
      error: status >= 500 ? "Internal Server Error" : error.name || "Bad Request",
      message:
        status >= 500
          ? "The API could not complete this request."
          : error.message,
      requestId: request.id,
      statusCode: status,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: "Not Found",
      message: `No route for ${request.method} ${request.url}`,
      requestId: request.id,
      statusCode: 404,
    });
  });

  await app.register(registerRoutes);

  return app;
};

module.exports = { buildApp, bigintSafe, buildLoggerOptions };
