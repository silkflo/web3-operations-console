// backend/test/redact.test.js
//
// The RPC credential must never reach a log, a database column or a console.
//
// This is a real regression test, not a hypothetical one. The incident that
// prompted it: an authenticated Sepolia endpoint started returning
// `429 Monthly capacity limit exceeded`, and the resulting ethers error carried
// the full `https://host/v2/<API KEY>` URL in `error.message` and in
// `error.stack`. Pino's default serializer logs both verbatim.
//
// So the integration test below drives a REAL ethers provider against a local
// server that returns 429, and first asserts that the raw error does contain
// the fake key — if that assertion ever fails, ethers changed and the rest of
// this file is guarding nothing. Then it asserts that nothing the application
// actually writes contains it.
//
// No suite here touches the database or the network beyond 127.0.0.1.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { Writable } = require("stream");

const pino = require("pino");

const {
  redactUrl,
  redactText,
  redactDeep,
  isSensitiveKey,
  describeRpcError,
  isRetryableRpcError,
  isRangeTooLargeError,
  errorSerializer,
} = require("../src/util/redact");
const { createProvider } = require("../src/chain/provider");
const { buildLoggerOptions } = require("../src/api/app");
const { stubConfig } = require("./fixtures/chain");

/** Distinctive enough that a substring match cannot succeed by accident. */
const FAKE_KEY = "FAKE_ALCHEMY_KEY_zq83Hd0Ppl4vN7";

/** Same, for the database password. Never a real value. */
const FAKE_DB_PASSWORD = "FAKE_PG_PASSWORD_Qv91mzR3tk";

// ------------------------------------------------------------- unit level ----

test("redactUrl keeps the provider host and drops the credential path", () => {
  assert.equal(
    redactUrl(`https://eth-sepolia.g.alchemy.com/v2/${FAKE_KEY}`),
    "https://eth-sepolia.g.alchemy.com/[redacted]"
  );

  assert.equal(
    redactUrl(`https://rpc.example.com/?apiKey=${FAKE_KEY}`),
    "https://rpc.example.com/[redacted]"
  );

  assert.equal(
    redactUrl(`https://user:${FAKE_KEY}@rpc.example.com`),
    "https://rpc.example.com/[redacted]"
  );
});

test("redactUrl leaves a credential-free URL readable", () => {
  assert.equal(redactUrl("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
  assert.equal(
    redactUrl("https://ethereum-sepolia-rpc.publicnode.com"),
    "https://ethereum-sepolia-rpc.publicnode.com"
  );
});

test("redactUrl protects a PostgreSQL connection string", () => {
  // DATABASE_URL is a credential too. Prisma puts the connection string into
  // its own error messages, so "we only redact RPC URLs" was a hole.
  assert.equal(
    redactUrl(
      `postgresql://web3:${FAKE_DB_PASSWORD}@127.0.0.1:5432/web3_index_prod?schema=public`
    ),
    "postgresql://127.0.0.1:5432/[redacted]"
  );

  assert.equal(
    redactUrl(`postgres://web3:${FAKE_DB_PASSWORD}@db.internal/web3`),
    "postgres://db.internal/[redacted]"
  );
});

test("other credential-bearing infrastructure schemes are protected too", () => {
  const cases = [
    `mysql://root:${FAKE_DB_PASSWORD}@localhost:3306/app`,
    `mongodb+srv://user:${FAKE_DB_PASSWORD}@cluster0.example.mongodb.net/db`,
    `redis://:${FAKE_DB_PASSWORD}@10.0.0.5:6379/0`,
    `rediss://:${FAKE_DB_PASSWORD}@10.0.0.5:6380/0`,
    `amqps://user:${FAKE_DB_PASSWORD}@rabbit.example.com:5671/vhost`,
    `mssql://sa:${FAKE_DB_PASSWORD}@sql.example.com:1433/db`,
    `ldaps://cn=admin:${FAKE_DB_PASSWORD}@ldap.example.com/dc=example`,
  ];

  cases.forEach((url) => {
    const redacted = redactUrl(url);

    assert.ok(
      !redacted.includes(FAKE_DB_PASSWORD),
      `credential survived redaction of ${url.split(":")[0]}: ${redacted}`
    );
    assert.match(redacted, /\[redacted\]/);
  });
});

test("a Prisma error message cannot retain the database password", () => {
  const message =
    "Invalid `prisma.factory.findUnique()` invocation: " +
    `Can't reach database server at postgresql://web3:${FAKE_DB_PASSWORD}@127.0.0.1:5432/web3_index_prod`;

  const cleaned = redactText(message);

  assert.ok(!cleaned.includes(FAKE_DB_PASSWORD), cleaned);
  assert.match(cleaned, /127\.0\.0\.1:5432/, "the host still identifies itself");
  assert.match(cleaned, /prisma\.factory\.findUnique/, "the operation survives");
});

test("a database credential cannot survive in an error message or stack", () => {
  const error = new Error(
    `connection failed: postgresql://web3:${FAKE_DB_PASSWORD}@10.0.0.5:5432/db`
  );
  error.code = "P1001";
  error.info = {
    databaseUrl: `postgresql://web3:${FAKE_DB_PASSWORD}@10.0.0.5:5432/db`,
    password: FAKE_DB_PASSWORD,
  };

  const serialized = JSON.stringify(errorSerializer(error));

  assert.ok(!serialized.includes(FAKE_DB_PASSWORD), serialized.slice(0, 400));
  assert.ok(
    !String(errorSerializer(error).stack || "").includes(FAKE_DB_PASSWORD),
    "the stack must be redacted as well as the message"
  );
  assert.equal(describeRpcError(error).code, "P1001", "the code still helps");
});

test("redactDeep redacts by PROPERTY NAME, whatever the value looks like", () => {
  // A password is not URL-shaped and not `key=value`-shaped. No text rule can
  // recognise it; only the key can.
  const secrets = {
    password: FAKE_DB_PASSWORD,
    passwd: FAKE_DB_PASSWORD,
    pwd: FAKE_DB_PASSWORD,
    apiKey: FAKE_KEY,
    api_key: FAKE_KEY,
    "API-KEY": FAKE_KEY,
    token: FAKE_KEY,
    accessToken: FAKE_KEY,
    access_token: FAKE_KEY,
    refreshToken: FAKE_KEY,
    secret: FAKE_KEY,
    clientSecret: FAKE_KEY,
    authorization: `Bearer ${FAKE_KEY}`,
    credentials: { anything: FAKE_DB_PASSWORD },
    dbPassword: FAKE_DB_PASSWORD,
    DATABASE_URL: `postgresql://u:${FAKE_DB_PASSWORD}@h/db`,
  };

  const cleaned = JSON.stringify(redactDeep(secrets));

  assert.ok(!cleaned.includes(FAKE_DB_PASSWORD), cleaned);
  assert.ok(!cleaned.includes(FAKE_KEY), cleaned);

  Object.keys(secrets).forEach((key) => {
    assert.ok(isSensitiveKey(key), `${key} must be treated as sensitive`);
  });
});

test("a sensitive key removes its whole subtree", () => {
  const cleaned = redactDeep({
    config: { credentials: { nested: { deeper: FAKE_DB_PASSWORD } } },
  });

  assert.ok(!JSON.stringify(cleaned).includes(FAKE_DB_PASSWORD));
});

test("key-name redaction does not destroy useful diagnostics", () => {
  const cleaned = redactDeep({
    host: "eth-sepolia.g.alchemy.com",
    responseStatus: "429 Too Many Requests",
    tokenCount: 5,
    publicKey: "0xabc",
    authority: "sepolia",
    requestId: "req_123",
  });

  assert.equal(cleaned.host, "eth-sepolia.g.alchemy.com");
  assert.equal(cleaned.responseStatus, "429 Too Many Requests");
  assert.equal(cleaned.tokenCount, 5);
  assert.equal(cleaned.publicKey, "0xabc");
  assert.equal(cleaned.authority, "sepolia");
  assert.equal(cleaned.requestId, "req_123");
});

test("redactText scrubs URLs and bare key=value secrets in free text", () => {
  const text =
    `connect ECONNREFUSED https://eth-sepolia.g.alchemy.com/v2/${FAKE_KEY} ` +
    `apiKey=${FAKE_KEY} token=${FAKE_KEY}`;

  const cleaned = redactText(text);

  assert.ok(!cleaned.includes(FAKE_KEY), cleaned);
  assert.match(cleaned, /eth-sepolia\.g\.alchemy\.com/, "host survives");
  assert.match(cleaned, /ECONNREFUSED/, "diagnosis survives");
});

test("redactDeep scrubs nested provider metadata", () => {
  const cleaned = redactDeep({
    info: {
      requestUrl: `https://rpc.example.com/v2/${FAKE_KEY}`,
      nested: [{ url: `https://rpc.example.com/v2/${FAKE_KEY}` }],
    },
  });

  assert.ok(!JSON.stringify(cleaned).includes(FAKE_KEY));
});

test("redactDeep terminates on a circular object", () => {
  const circular = { name: "outer" };
  circular.self = circular;

  assert.doesNotThrow(() => redactDeep(circular));
});

test("describeRpcError keeps what an operator needs and nothing else", () => {
  const described = describeRpcError({
    message: `exceeded maximum retry limit (info={ "requestUrl": "https://eth-sepolia.g.alchemy.com/v2/${FAKE_KEY}" })`,
    code: "SERVER_ERROR",
    info: {
      requestUrl: `https://eth-sepolia.g.alchemy.com/v2/${FAKE_KEY}`,
      responseStatus:
        "599 CLIENT ESCALATED SERVER ERROR (429 Too Many Requests; exceeded maximum retry limit)",
      responseBody: '{"error":{"message":"Monthly capacity limit exceeded"}}',
    },
  });

  assert.equal(described.category, "rate-limited");
  assert.equal(described.rateLimited, true);
  assert.equal(described.timeout, false);
  assert.equal(described.status, 429);
  assert.equal(described.host, "eth-sepolia.g.alchemy.com");
  assert.equal(described.code, "SERVER_ERROR");
  assert.ok(!JSON.stringify(described).includes(FAKE_KEY));
});

test("describeRpcError classifies timeouts and network failures", () => {
  assert.equal(
    describeRpcError({ code: "RPC_TIMEOUT", message: "x timed out after 8000ms" })
      .category,
    "timeout"
  );

  assert.equal(
    describeRpcError({ message: "connect ECONNREFUSED 127.0.0.1:8545" }).category,
    "network"
  );

  assert.equal(describeRpcError("plain string failure").category, "unknown");
});

test("retryable and range-too-large classification do not overlap", () => {
  const capacity = { message: "Monthly capacity limit exceeded", status: 429 };
  const range = { message: "query returned more than 10000 results" };

  assert.equal(isRetryableRpcError(capacity), true);
  assert.equal(
    isRangeTooLargeError(capacity),
    false,
    "a quota message must never be read as a range complaint"
  );

  assert.equal(isRangeTooLargeError(range), true);
});

// --------------------------------------------------- against a real ethers ----

/**
 * Shuts a test server down.
 *
 * `close()` alone waits for open sockets, and a provider that timed out leaves
 * one behind — which is what hung this suite the first time it was written.
 */
const closeServer = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

/** Starts a local server that answers every JSON-RPC call with `status`. */
const withRpcServer = async (status, body, fn) => {
  const server = http.createServer((request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await closeServer(server);
  }
};

test("a real 429 from ethers still carries the credential — the hazard is real", async () => {
  await withRpcServer(
    429,
    { error: { code: -32005, message: "Monthly capacity limit exceeded" } },
    async (origin) => {
      const provider = createProvider({
        rpcUrl: `${origin}/v2/${FAKE_KEY}`,
        chainId: 11155111,
        timeoutMs: 3000,
        maxAttempts: 1,
      });

      try {
        await provider.getBlockNumber();
        assert.fail("expected the provider to reject");
      } catch (error) {
        // If this ever fails, ethers stopped embedding the URL and the
        // redaction below is guarding nothing. Fix the test, do not delete it.
        assert.ok(
          String(error.message).includes(FAKE_KEY),
          "ethers is expected to put the request URL in the message"
        );

        assert.ok(
          !JSON.stringify(describeRpcError(error)).includes(FAKE_KEY),
          "describeRpcError must not carry the credential"
        );

        assert.ok(
          !JSON.stringify(errorSerializer(error)).includes(FAKE_KEY),
          "the pino serializer must not carry the credential"
        );

        const described = describeRpcError(error);
        assert.equal(described.rateLimited, true);
        assert.equal(described.status, 429);
        assert.equal(described.host, new URL(origin).host);
      } finally {
        provider.destroy();
      }
    }
  );
});

test("the API logger writes no RPC credential for a real provider error", async () => {
  await withRpcServer(
    429,
    { error: { code: -32005, message: "Monthly capacity limit exceeded" } },
    async (origin) => {
      const provider = createProvider({
        rpcUrl: `${origin}/v2/${FAKE_KEY}`,
        chainId: 11155111,
        timeoutMs: 3000,
        maxAttempts: 1,
      });

      let caught = null;

      try {
        await provider.getBlockNumber();
      } catch (error) {
        caught = error;
      } finally {
        provider.destroy();
      }

      assert.ok(caught, "the provider must have rejected");

      const written = [];
      const sink = new Writable({
        write(chunk, _encoding, done) {
          written.push(chunk.toString());
          done();
        },
      });

      const config = stubConfig();
      const logger = pino(
        { ...buildLoggerOptions(config), level: "trace" },
        sink
      );

      // Every shape the application actually logs an RPC failure in.
      logger.error({ err: caught }, "unhandled error serving request");
      logger.warn({ error: caught }, "health: RPC unreachable");
      logger.warn({ rpc: describeRpcError(caught) }, "live state unavailable");

      const output = written.join("");

      assert.ok(output.length > 0, "the logger produced output to inspect");
      assert.ok(
        !output.includes(FAKE_KEY),
        `credential leaked into the log: ${output.slice(0, 400)}`
      );
      assert.match(output, /rate-limited/, "the useful classification survives");
      assert.match(output, /127\.0\.0\.1/, "the provider host survives");
    }
  );
});

test("a stalled provider times out fast and leaks no credential", async () => {
  // A server that accepts the connection and never answers: the exact shape
  // that used to hold an API request open until Nginx returned 504.
  const server = http.createServer(() => {});

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = server.address().port;
  const provider = createProvider({
    rpcUrl: `http://127.0.0.1:${port}/v2/${FAKE_KEY}`,
    chainId: 11155111,
    timeoutMs: 400,
    maxAttempts: 1,
  });

  const started = Date.now();

  try {
    await provider.getBlockNumber();
    assert.fail("expected the provider to time out");
  } catch (error) {
    const elapsed = Date.now() - started;

    // Ethers' default here is 300_000ms. Anything near that is the bug.
    assert.ok(elapsed < 5000, `provider hung for ${elapsed}ms`);

    const described = describeRpcError(error);

    assert.equal(described.category, "timeout");
    assert.equal(described.timeout, true);
    assert.ok(!JSON.stringify(errorSerializer(error)).includes(FAKE_KEY));
  } finally {
    provider.destroy();
    await closeServer(server);
  }
});
