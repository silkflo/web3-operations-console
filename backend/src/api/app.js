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

const { registerRoutes } = require("./routes");

/** Serializes BigInt safely: JSON.stringify throws on it by default. */
const bigintSafe = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, inner) =>
      typeof inner === "bigint" ? inner.toString() : inner
    )
  );

const buildApp = async ({ runtime, logger = true } = {}) => {
  const { config } = runtime;

  const app = Fastify({
    logger:
      logger === false
        ? false
        : {
            level: config.api.logLevel,
            // Structured logs; never log a full env or connection string.
            redact: {
              paths: ["req.headers.authorization", "req.headers.cookie"],
              remove: true,
            },
          },
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

module.exports = { buildApp, bigintSafe };
