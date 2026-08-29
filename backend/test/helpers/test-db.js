// backend/test/helpers/test-db.js
//
// The only way a test may obtain a database connection.
//
// Every client is built with an explicit datasource override pointing at
// DATABASE_URL_TEST, so a test cannot reach the development database even if
// DATABASE_URL happens to be set in the environment — which it always is.

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const {
  resolveTestDatabaseUrl,
  assertSafeDestructiveTarget,
  UnsafeTestDatabaseError,
} = require("../../src/db/test-guard");

/** True when a validated test database is configured. */
const isTestDatabaseConfigured = () => {
  try {
    resolveTestDatabaseUrl();
    return true;
  } catch {
    return false;
  }
};

/** Reason the suite is skipping, or false when it can run. */
const skipReason = () => {
  try {
    resolveTestDatabaseUrl();
    return false;
  } catch (error) {
    if (error instanceof UnsafeTestDatabaseError) {
      // First line only: node:test prints the reason inline.
      return error.message.split("\n")[0];
    }

    throw error;
  }
};

/**
 * A PrismaClient pinned to the test database.
 *
 * The datasource override is the isolation mechanism. Without it Prisma would
 * read DATABASE_URL and connect to development.
 */
const createTestPrisma = () => {
  const target = resolveTestDatabaseUrl();
  const { PrismaClient } = require("@prisma/client");

  return new PrismaClient({
    datasources: { db: { url: target.url } },
    log: ["warn", "error"],
  });
};

/**
 * Empties the test database.
 *
 * Guarded again at the point of use: this function truncates, so it re-checks
 * its target rather than trusting that an earlier check happened.
 */
const truncateAll = async (prisma) => {
  assertSafeDestructiveTarget(process.env.DATABASE_URL_TEST, {
    devUrl: process.env.DATABASE_URL,
  });

  // RESTART IDENTITY keeps ids predictable across runs; CASCADE handles the
  // foreign keys without ordering the deletes by hand.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "chain_events", "split_rounds", "splits", "indexer_checkpoints", "factories" RESTART IDENTITY CASCADE`
  );
};

/**
 * Runs `fn` with a clean, isolated database, then disconnects.
 *
 * Truncating before rather than after means a failed run leaves its state on
 * disk for inspection, and the next run still starts clean.
 */
const withTestDatabase = async (fn) => {
  const prisma = createTestPrisma();

  try {
    await truncateAll(prisma);
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
};

module.exports = {
  createTestPrisma,
  truncateAll,
  withTestDatabase,
  isTestDatabaseConfigured,
  skipReason,
};
