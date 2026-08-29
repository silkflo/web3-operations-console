// backend/scripts/postinstall.js
//
// Regenerates the Prisma client after an install.
//
// `npm ci` deletes node_modules, which takes the generated client with it, so
// without this a clean install leaves the API and indexer unable to start until
// someone remembers to run `prisma generate` by hand.
//
// The Prisma CLI is a devDependency, so a production `npm ci --omit=dev` will
// not have it. That is a legitimate install pattern, so the script skips with a
// clear message rather than failing the install — it never silently swallows a
// real generate failure, only an absent CLI.

const { spawnSync } = require("child_process");

let cliPath;

try {
  cliPath = require.resolve("prisma/build/index.js");
} catch {
  console.log(
    "[postinstall] Prisma CLI not installed (devDependency omitted); " +
      "skipping client generation.\n" +
      "[postinstall] Run `npx prisma generate` before starting the API or indexer."
  );
  process.exit(0);
}

const result = spawnSync(process.execPath, [cliPath, "generate"], {
  stdio: "inherit",
  cwd: require("path").join(__dirname, ".."),
});

// A CLI that exists but fails is a real problem and must fail the install.
process.exit(result.status === null ? 1 : result.status);
