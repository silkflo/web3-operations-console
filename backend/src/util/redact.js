// backend/src/util/redact.js
//
// Secret-safe logging.
//
// An authenticated RPC endpoint carries its credential in the URL path
// (`https://host/v2/<API KEY>`). Ethers puts that URL into the *message* and
// the *stack* of every failure it raises:
//
//   exceeded maximum retry limit (request={  }, response={  }, error=null,
//   info={ "requestUrl": "https://host/v2/REAL_KEY", ... }, code=SERVER_ERROR)
//
// Pino's default error serializer logs `err.message` and `err.stack` verbatim,
// so a single 429 is enough to write the key into the journal, into `lastError`
// in PostgreSQL, and into anything shipping those logs elsewhere.
//
// The RPC endpoint is not the only credential in reach. `DATABASE_URL` carries a
// password in its userinfo component, and Prisma puts the connection string into
// its own error messages:
//
//   Invalid `prisma.factory.findUnique()` — postgresql://web3:PASSWORD@host/db
//
// So redaction is not "scrub http URLs"; it is "scrub every credential-bearing
// URL scheme this deployment can produce", plus every value whose *property
// name* says it is a secret, whatever shape that value happens to have.
//
// Everything here is defensive rather than clever: redact at every sink, keep
// only what an operator actually needs (host, status, category), and never let
// a path, query string or userinfo component through.

const REDACTED = "[redacted]";

/**
 * URL schemes that can carry a credential.
 *
 * Beyond the RPC endpoint: PostgreSQL is what this backend actually connects to,
 * and the rest are the common infrastructure schemes that embed `user:password@`
 * in the same way — so a future queue, cache or replica URL is covered the day
 * it is introduced rather than the day after it leaks.
 */
const CREDENTIAL_URL_SCHEMES = [
  "https?",
  "wss?",
  "postgres(?:ql)?",
  "mysql",
  "mariadb",
  "mongodb(?:\\+srv)?",
  "rediss?",
  "amqps?",
  "mssql",
  "sqlserver",
  "clickhouse",
  "cockroachdb",
  "ldaps?",
  "s?ftp",
  "smtps?",
];

/** URLs inside free text. Delimiters that cannot appear in a URL end a match. */
const URL_IN_TEXT = new RegExp(
  `\\b(?:${CREDENTIAL_URL_SCHEMES.join("|")}):\\/\\/[^\\s"'\`<>()[\\]{},;\\\\]+`,
  "gi"
);

/** `key=value` credentials that are not part of a parsed URL. */
const CREDENTIAL_PAIR =
  /\b(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|authorization|bearer|token|secret|client[-_]?secret|password|passwd|pwd|connection[-_]?string|database[-_]?url)(\s*[=:]\s*)([^\s"'&,;]+)/gi;

/**
 * Property-name endings whose VALUE is a secret regardless of its shape.
 *
 * A password is not URL-shaped and survives every text-level rule, so the only
 * reliable defence when walking an arbitrary object is to look at the key.
 *
 * Matched against the key with separators removed and case folded, so
 * `accessToken`, `access_token`, `ACCESS-TOKEN` and `dbPassword` are all caught
 * by the same short list. Suffix matching rather than exact matching is the
 * point: `clientSecret` is as sensitive as `secret`.
 */
const SENSITIVE_KEY_SUFFIXES = [
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "credentials",
  "authorization",
  "auth",
  "apikey",
  "accesskey",
  "privatekey",
  "mnemonic",
  "connectionstring",
  "databaseurl",
  "dsn",
];

/** Longest error text kept. Enough to diagnose, short enough to log. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * Strips the credential-bearing parts of one URL, keeping scheme, host and port.
 *
 * A URL with no path and no query is already safe and is returned unchanged, so
 * ordinary lines like "listening on http://127.0.0.1:4000" stay readable.
 */
const redactUrl = (value) => {
  const raw = String(value === undefined || value === null ? "" : value).trim();

  if (!raw) {
    return "";
  }

  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    // URL-shaped but unparseable: assume the worst and drop all of it.
    return REDACTED;
  }

  const scheme = parsed.protocol.replace(/:$/, "");
  const carriesSecret =
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    Boolean(parsed.search) ||
    Boolean(parsed.hash) ||
    (parsed.pathname && parsed.pathname !== "/");

  return carriesSecret
    ? `${scheme}://${parsed.host}/${REDACTED}`
    : `${scheme}://${parsed.host}`;
};

/** Host of a URL, or null. Safe to log: it names the provider, not the key. */
const hostOf = (value) => {
  try {
    return new URL(String(value)).host || null;
  } catch {
    return null;
  }
};

/** Removes every URL credential and `key=value` secret from free text. */
const redactText = (value) => {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .replace(URL_IN_TEXT, (match) => redactUrl(match))
    .replace(
      CREDENTIAL_PAIR,
      (_match, key, separator) => `${key}${separator}${REDACTED}`
    );
};

/** True when a property name declares its value to be a secret. */
const isSensitiveKey = (key) => {
  const normalized = String(key).replace(/[-_\s]/g, "").toLowerCase();

  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
};

/**
 * Recursively redacts a value. Bounded in depth and in width.
 *
 * Two independent rules, because either alone leaks:
 *   - by VALUE, for anything URL-shaped or `key=value`-shaped;
 *   - by KEY, for `{ password: "hunter2" }`, which no text rule can recognise.
 *
 * A sensitive key removes the whole subtree, so nesting a secret one level
 * deeper does not smuggle it out.
 */
const redactDeep = (value, depth = 0) => {
  if (depth > 4) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return redactText(value).slice(0, MAX_MESSAGE_LENGTH);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => redactDeep(entry, depth + 1));
  }

  const out = {};

  Object.keys(value)
    .slice(0, 20)
    .forEach((key) => {
      try {
        out[key] = isSensitiveKey(key)
          ? REDACTED
          : redactDeep(value[key], depth + 1);
      } catch {
        out[key] = REDACTED;
      }
    });

  return out;
};

const RATE_LIMIT_PATTERN =
  /(rate[- ]?limit|too many requests|capacity limit|quota|throttl|exceeded maximum retry)/i;
const TIMEOUT_PATTERN =
  /(timeout|timed out|etimedout|esockettimedout|aborted)/i;
const NETWORK_PATTERN =
  /(econnrefused|econnreset|enotfound|ehostunreach|enetunreach|epipe|socket hang up|network error|fetch failed)/i;

/** HTTP status carried by an ethers or undici error, when there is one. */
const statusOf = (error) => {
  if (!error || typeof error !== "object") {
    return null;
  }

  if (Number.isInteger(error.status)) {
    return error.status;
  }

  if (Number.isInteger(error.statusCode)) {
    return error.statusCode;
  }

  const info = error.info && typeof error.info === "object" ? error.info : {};

  if (Number.isInteger(info.responseStatus)) {
    return info.responseStatus;
  }

  // Ethers reports "429 Too Many Requests", or the escalated form
  // "599 CLIENT ESCALATED SERVER ERROR (429 Too Many Requests; ...)". The
  // parenthesised original status is the useful one.
  const text = `${info.responseStatus || ""} ${error.message || ""}`;
  const escalated = text.match(/\((\d{3})\s/);

  if (escalated) {
    return Number.parseInt(escalated[1], 10);
  }

  const leading = String(info.responseStatus || "").match(/^(\d{3})\b/);

  return leading ? Number.parseInt(leading[1], 10) : null;
};

/**
 * A safe, useful description of an RPC failure.
 *
 * Keeps the provider host, HTTP status, error category, request id and whether
 * this was a timeout or a rate limit. Drops the URL path, the query string and
 * every nested ethers request/response object.
 */
const describeRpcError = (error) => {
  const raw =
    error && typeof error === "object" ? error : { message: String(error) };
  const info = raw.info && typeof raw.info === "object" ? raw.info : {};
  const message = redactText(
    String(raw.shortMessage || raw.message || raw)
  ).slice(0, MAX_MESSAGE_LENGTH);
  const haystack = `${raw.code || ""} ${raw.shortMessage || ""} ${
    raw.message || ""
  } ${info.responseStatus || ""} ${info.responseBody || ""}`;

  const status = statusOf(raw);
  const rateLimited = status === 429 || RATE_LIMIT_PATTERN.test(haystack);
  const timeout =
    raw.code === "TIMEOUT" ||
    raw.code === "RPC_TIMEOUT" ||
    raw.name === "AbortError" ||
    (!rateLimited && TIMEOUT_PATTERN.test(haystack));
  const network = !rateLimited && !timeout && NETWORK_PATTERN.test(haystack);

  let category = "unknown";

  if (rateLimited) {
    category = "rate-limited";
  } else if (timeout) {
    category = "timeout";
  } else if (network) {
    category = "network";
  } else if (status && status >= 500) {
    category = "server-error";
  } else if (status && status >= 400) {
    category = "client-error";
  }

  return {
    category,
    message,
    code: raw.code || raw.name || null,
    status,
    host: hostOf(info.requestUrl) || hostOf(raw.url) || null,
    requestId: raw.requestId || info.requestId || null,
    rateLimited,
    timeout,
  };
};

/** True when retrying later has a realistic chance of succeeding. */
const isRetryableRpcError = (error) => {
  const described = describeRpcError(error);

  return (
    described.rateLimited ||
    described.timeout ||
    described.category === "network" ||
    described.category === "server-error"
  );
};

/**
 * True when the provider refused the *size* of an eth_getLogs range.
 *
 * Checked only after the rate-limit test, because "Monthly capacity limit
 * exceeded" also contains the words "limit exceeded" and must never be mistaken
 * for a complaint about the block range.
 */
const isRangeTooLargeError = (error) => {
  if (describeRpcError(error).rateLimited) {
    return false;
  }

  const raw = error && typeof error === "object" ? error : {};
  const info = raw.info && typeof raw.info === "object" ? raw.info : {};
  const haystack = `${raw.shortMessage || ""} ${raw.message || ""} ${
    info.responseBody || ""
  } ${(raw.error && raw.error.message) || ""}`;

  return /(block range|range is too|query returned more than|too many results|more than \d+ results|response size exceeded|log response size|exceeds the range|limited to \d+ blocks?|range too large|query timeout exceeded)/i.test(
    haystack
  );
};

/**
 * Pino error serializer.
 *
 * Replaces pino's default, which logs `err.message` and `err.stack` untouched.
 * Nested ethers `request`/`response` objects are dropped rather than walked:
 * their only useful content is already summarized above.
 */
const errorSerializer = (error) => {
  if (!error || typeof error !== "object") {
    return { type: "Error", message: redactText(String(error)) };
  }

  const described = describeRpcError(error);

  return {
    type: error.name || "Error",
    message: described.message,
    code: described.code,
    category: described.category,
    status: described.status,
    host: described.host,
    rateLimited: described.rateLimited,
    timeout: described.timeout,
    info: error.info ? redactDeep(error.info) : undefined,
    stack: error.stack
      ? redactText(String(error.stack)).slice(0, 2000)
      : undefined,
  };
};

module.exports = {
  REDACTED,
  CREDENTIAL_URL_SCHEMES,
  SENSITIVE_KEY_SUFFIXES,
  redactUrl,
  redactText,
  redactDeep,
  isSensitiveKey,
  hostOf,
  describeRpcError,
  isRetryableRpcError,
  isRangeTooLargeError,
  errorSerializer,
};
