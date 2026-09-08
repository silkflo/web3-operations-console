// backend/test/boundaries.test.js
//
// Security and architecture boundaries that no runtime test would catch,
// checked by reading the source tree:
//
//   - Prisma, the database URL and the RPC secret must never reach the browser
//     bundle;
//   - the browser must no longer scan event logs;
//   - no signer, wallet, mnemonic or private key may exist anywhere in backend
//     or frontend code;
//   - .env.example must contain placeholders, never real values.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const BACKEND = path.join(REPO, "backend");

/** Every .js/.jsx file under a directory, excluding node_modules and builds. */
const walk = (dir, acc = []) => {
  if (!fs.existsSync(dir)) {
    return acc;
  }

  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (["node_modules", ".next", ".git", "artifacts", "cache"].includes(entry.name)) {
      return;
    }

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (/\.(js|jsx)$/.test(entry.name)) {
      acc.push(full);
    }
  });

  return acc;
};

const frontendFiles = () => [
  ...walk(path.join(REPO, "pages")),
  ...walk(path.join(REPO, "lib")),
  ...walk(path.join(REPO, "components")),
];

const read = (file) => fs.readFileSync(file, "utf8");

/**
 * Source with comments removed.
 *
 * Without this, a file documenting "holds no private key" fails its own check.
 */
const readCode = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// -------------------------------------------------- database stays server ----

test("no frontend file imports Prisma or a database client", () => {
  const offenders = frontendFiles().filter((file) => {
    const source = read(file);
    return (
      /@prisma\/client/.test(source) ||
      /require\(["']prisma["']\)/.test(source) ||
      /\bnew PrismaClient\b/.test(source) ||
      /\bpg\b.*require\(["']pg["']\)/.test(source)
    );
  });

  assert.deepEqual(
    offenders.map((f) => path.relative(REPO, f)),
    [],
    "Prisma must exist only in backend code"
  );
});

test("no frontend file references DATABASE_URL or a connection string", () => {
  const offenders = frontendFiles().filter((file) => {
    const source = read(file);
    return /DATABASE_URL/.test(source) || /postgres(ql)?:\/\//.test(source);
  });

  assert.deepEqual(offenders.map((f) => path.relative(REPO, f)), []);
});

test("no frontend file reads a server-only RPC secret", () => {
  // NEXT_PUBLIC_SEPOLIA_RPC_URL is a deliberate public override and allowed;
  // the bare SEPOLIA_RPC_URL is the backend secret and is not.
  const offenders = frontendFiles().filter((file) => {
    const source = read(file);
    return /process\.env\.SEPOLIA_RPC_URL\b/.test(source);
  });

  assert.deepEqual(offenders.map((f) => path.relative(REPO, f)), []);
});

// ------------------------------------------- browser no longer scans logs ----

test("the console page performs no event-log scan", () => {
  const page = read(path.join(REPO, "pages", "index.js"));

  assert.ok(!/queryFilter/.test(page), "no queryFilter in the browser");
  assert.ok(!/getLogs/.test(page), "no getLogs in the browser");
  assert.ok(
    !/JsonRpcProvider/.test(page),
    "the browser must not construct an RPC provider"
  );
  assert.ok(
    !/from "ethers"|require\("ethers"\)/.test(page),
    "ethers must not ship to the browser"
  );
});

test("the console page talks only to the API", () => {
  const page = read(path.join(REPO, "pages", "index.js"));

  assert.match(page, /web3-api-client/, "uses the API client");
  assert.ok(
    !/loadFactorySnapshot/.test(page),
    "the browser-side chain loader is gone"
  );
});

test("the API client reads only its public build-injected API URL", () => {
  const client = read(path.join(REPO, "lib", "web3-api-client.js"));

  assert.match(client, /const getApiBaseUrl = \(\) =>/);
  assert.match(client, /NEXT_PUBLIC_WEB3_API_URL/);
  assert.ok(!/DATABASE_URL/.test(client), "client must not read a database URL");
  assert.ok(!/SEPOLIA_RPC_URL/.test(client), "client must not read an RPC URL");
});

// ---------------------------------------------------- no write capability ----

/** Signing capability, in every form ethers offers it. */
const SIGNING_CAPABILITY = [
  /\bnew (?:ethers\.)?Wallet\b/,
  /\bWallet\.(?:fromPhrase|fromEncryptedJson|fromEncryptedJsonSync|createRandom)\b/,
  /\bHDNodeWallet\b/,
  /getSigner\(/,
  /sendTransaction\(/,
  /\bsign(?:Transaction|Message|TypedData)\(/,
  /\.connect\(wallet/,
];

/**
 * Key material being HELD, rather than merely named.
 *
 * These two checks were `/privateKey/i` and `/mnemonic/i` — a bare mention of
 * either word anywhere in a file. That flagged src/util/redact.js, whose entire
 * job is to recognise those property names so their values never reach a log; a
 * deny-list has to name what it denies. What actually matters is whether the
 * backend reads such a value or assigns one, so that is what is tested now.
 * Every capability check above is unchanged, and four more were added.
 */
const KEY_MATERIAL = [
  /\b(?:privateKey|private_key|mnemonic)\s*[:=][^=]/i,
  /process\.env\.[A-Za-z0-9_]*(?:PRIVATE_KEY|MNEMONIC)\b/,
  /\bmnemonic\s*\(/i,
];

const KEY_PATTERNS = [...SIGNING_CAPABILITY, ...KEY_MATERIAL];

test("no signer, wallet or transaction call exists in backend code", () => {
  const offenders = walk(path.join(BACKEND, "src")).filter((file) => {
    const source = readCode(file);
    return KEY_PATTERNS.some((pattern) => pattern.test(source));
  });

  assert.deepEqual(
    offenders.map((f) => path.relative(REPO, f)),
    [],
    "the backend is read-only and holds no key material"
  );
});

test("the key-material check still catches a real leak", () => {
  // Guards the guard. The patterns above are only worth having if they still
  // fire on exactly the code they exist to forbid.
  const MUST_BE_CAUGHT = [
    'const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY);',
    'const w = new ethers.Wallet(key);',
    'const signer = provider.getSigner();',
    'const w = Wallet.fromPhrase(process.env.DEMO_MNEMONIC);',
    'const w = HDNodeWallet.createRandom();',
    'await contract.connect(wallet).fund();',
    'const privateKey = "0xabc";',
    'const cfg = { mnemonic: "test test test" };',
    'await signer.sendTransaction(tx);',
    'await signer.signMessage("hi");',
    'await signer.signTypedData(domain, types, value);',
  ];

  MUST_BE_CAUGHT.forEach((snippet) => {
    assert.ok(
      KEY_PATTERNS.some((pattern) => pattern.test(snippet)),
      `key-material check missed: ${snippet}`
    );
  });

  // And it must NOT fire on a redaction deny-list that only names the terms.
  const denyList =
    'const SENSITIVE = ["privatekey", "mnemonic", "password", "apikey"];';

  assert.ok(
    !KEY_PATTERNS.some((pattern) => pattern.test(denyList)),
    "naming a secret in a deny-list is not the same as holding one"
  );
});

test("no frontend file holds key material", () => {
  // The standalone repo carries no wallet code at all (the portfolio's
  // useWeb3Wallet hook and its /web3-demo pages were not extracted). Key
  // material must appear nowhere in the frontend, and the check below proves
  // no wallet connection creeps back in.
  const offenders = frontendFiles().filter((file) => {
    const source = readCode(file);
    return (
      /\bnew Wallet\b/.test(source) ||
      /privateKey/i.test(source) ||
      /DEMO_MNEMONIC/.test(source)
    );
  });

  assert.deepEqual(offenders.map((f) => path.relative(REPO, f)), []);
});

test("the console introduces no wallet connection", () => {
  // The console is read-only: no wallet hook, no account request, no injected
  // provider may appear in the page, the API client or the shared library.
  const consoleFiles = [
    path.join(REPO, "pages", "index.js"),
    path.join(REPO, "lib", "web3-api-client.js"),
    ...walk(path.join(REPO, "lib", "contract-intelligence")),
  ];

  consoleFiles.forEach((file) => {
    const source = readCode(file);
    const name = path.relative(REPO, file);

    assert.ok(!/useWeb3Wallet/.test(source), `${name} must not use the wallet hook`);
    assert.ok(
      !/eth_requestAccounts/.test(source),
      `${name} must not request accounts`
    );
    assert.ok(
      !/window\.ethereum/.test(source),
      `${name} must not touch an injected wallet`
    );
  });
});

// --------------------------------------------------------- env hygiene ----

test(".env examples carry placeholders, never real secrets", () => {
  const backendExample = read(path.join(BACKEND, ".env.example"));
  const contractsExample = read(
    path.join(REPO, "ethereum-v3", ".env.example")
  );

  const rpcMatch = backendExample.match(/^SEPOLIA_RPC_URL=(.+)$/m);

  assert.ok(rpcMatch, "backend example must document SEPOLIA_RPC_URL");
  assert.match(
    rpcMatch[1],
    /(YOUR_|your-|example|placeholder)/i,
    "Sepolia RPC URL must visibly contain a placeholder"
  );

  const allExamples = `${backendExample}\n${contractsExample}`;

  assert.ok(
    !/alchemy\.com\/v2\/(?!YOUR_)[A-Za-z0-9_-]{10,}/i.test(allExamples),
    "no real Alchemy key"
  );
  assert.ok(
    !/infura\.io\/v3\/(?!YOUR_)[A-Za-z0-9_-]{20,}/i.test(allExamples),
    "no real Infura key"
  );
  assert.ok(
    !/DEPLOYER_PRIVATE_KEY=0x[a-f0-9]{64}/i.test(allExamples),
    "no real deployer private key"
  );
  assert.ok(
    !/DEMO_MNEMONIC=\s*\w+(?:\s+\w+){11,}/i.test(allExamples),
    "no real demo mnemonic"
  );
  assert.ok(
    !/ETHERSCAN_API_KEY=(?!YOUR_|your-|$)[A-Za-z0-9_-]{10,}/i.test(
      allExamples
    ),
    "no real Etherscan API key"
  );
});

test("backend .env is gitignored", () => {
  const ignore = read(path.join(BACKEND, ".gitignore"));
  assert.match(ignore, /^\.env$/m);
});

test("the deployment doc forbids database and RPC secrets in the frontend build", () => {
  // Named the frontend build rather than a hosting provider: the frontend runs
  // on the same VPS as the API, and the rule is about what gets compiled into
  // the browser bundle, not about who hosts it.
  const docPath = path.join(BACKEND, "DEPLOYMENT.md");

  assert.ok(fs.existsSync(docPath), "DEPLOYMENT.md must exist");

  const doc = read(docPath);

  assert.match(doc, /NEXT_PUBLIC_WEB3_API_URL/);
  assert.match(
    doc,
    /not\*{0,2}\s+configure[\s\S]{0,120}DATABASE_URL/i,
    "must tell the reader to keep DATABASE_URL out of the frontend build"
  );
  assert.match(
    doc,
    /SEPOLIA_RPC_URL/,
    "must name the RPC secret as something the frontend never receives"
  );
  assert.match(doc, /Bind to localhost|127\.0\.0\.1:5432/, "database must not be public");
  assert.match(doc, /never signs|does not sign|never sign/i, "API must be stated read-only");
});

test("the deployment doc describes the deployment that actually exists", () => {
  // Wrong paths in a runbook are worse than no runbook: they get pasted into a
  // root shell. This pins the two facts that were wrong.
  const doc = read(path.join(BACKEND, "DEPLOYMENT.md"));

  assert.match(
    doc,
    /\/home\/floadmin\/apps\/web3-operations-console-public/,
    "must use the real production path"
  );
  assert.ok(
    !/\/srv\/flo-portfolio/.test(doc),
    "the invented /srv path must not appear"
  );
  assert.ok(
    !/vercel/i.test(doc),
    "the frontend is on the VPS; no hosting-platform instructions"
  );
});
