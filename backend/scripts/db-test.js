// backend/scripts/db-test.js
//
// Runs a Prisma command against DATABASE_URL_TEST, and only ever against it.
//
// Prisma reads DATABASE_URL from the environment, so every test-side migration
// has to override it. Doing that through this script means the safety guard
// runs FIRST, every time — there is no path where a developer types a Prisma
// command and it lands on the development database.
//
// Usage:
//   node scripts/db-test.js migrate    # apply migrations to the test database
//   node scripts/db-test.js reset      # drop and recreate the test schema
//   node scripts/db-test.js status

const { spawnSync } = require("child_process");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  assertSafeDestructiveTarget,
  UnsafeTestDatabaseError,
} = require("../src/db/test-guard");

const COMMANDS = {
  migrate: ["migrate", "deploy"],
  reset: ["migrate", "reset", "--force", "--skip-generate"],
  status: ["migrate", "status"],
  push: ["db", "push", "--skip-generate"],
};

const command = process.argv[2] || "migrate";

if (!COMMANDS[command]) {
  console.error(
    `Unknown command "${command}". Expected one of: ${Object.keys(COMMANDS).join(", ")}`
  );
  process.exit(1);
}

let target;

try {
  // Guard runs before Prisma is even spawned. A misconfigured environment
  // fails here, pointing at the test database, rather than halfway through a
  // reset pointed somewhere else.
  target = assertSafeDestructiveTarget(process.env.DATABASE_URL_TEST, {
    devUrl: process.env.DATABASE_URL,
  });
} catch (error) {
  if (error instanceof UnsafeTestDatabaseError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }

  throw error;
}

console.log(
  `[db:test] ${command} -> ${target.host}:${target.port}/${target.database}`
);

const result = spawnSync(
  process.execPath,
  [require.resolve("prisma/build/index.js"), ...COMMANDS[command]],
  {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      // The override that keeps Prisma off the development database.
      DATABASE_URL: process.env.DATABASE_URL_TEST,
    },
  }
);

process.exit(result.status === null ? 1 : result.status);
