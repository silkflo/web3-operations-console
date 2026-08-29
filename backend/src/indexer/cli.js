// backend/src/indexer/cli.js
//
// Commands: sync | watch | status | rebuild
//
// `rebuild` is destructive and therefore requires --confirm, refuses to run
// when NODE_ENV=production without --i-know-this-is-production, and prints what
// it is about to delete first.

const { createRuntime } = require("../runtime");
const { disconnectPrisma } = require("../db/client");

const argv = process.argv.slice(2);
const command = argv[0];
const hasFlag = (flag) => argv.includes(flag);

const printStatus = (status) => {
  if (!status.initialized) {
    console.log("Indexer has never run against this factory.");
    console.log("  chain id:        ", status.chainId);
    console.log("  factory:         ", status.factoryAddress);
    console.log("  deployment block:", status.deploymentBlock);
    console.log('Run "npm run indexer:sync" to build the index.');
    return;
  }

  console.log("Indexer status");
  console.log("  chain id:          ", status.chainId);
  console.log("  factory:           ", status.factoryAddress);
  console.log("  deployment block:  ", status.deploymentBlock);
  console.log("  last indexed block:", status.lastIndexedBlock);
  console.log("  last indexed hash: ", status.lastIndexedHash || "(none)");
  console.log("  splits tracked:    ", status.splitCount);
  console.log("  events indexed:    ", status.eventCount);
  console.log("  reorgs handled:    ", status.reorgCount);
  console.log("  last sync started: ", status.lastSyncStartedAt || "(never)");
  console.log("  last sync finished:", status.lastSyncCompletedAt || "(never)");

  if (status.lastError) {
    console.log("  last error:        ", status.lastError);
  }
};

const runSync = async (indexer) => {
  const result = await indexer.sync();

  if (result.upToDate) {
    console.log(
      `[indexer] already up to date at confirmed block ${result.to}` +
        (result.reorg ? " (after reorg rollback)" : "")
    );
  } else {
    console.log(
      `[indexer] indexed blocks ${result.from}-${result.to}: ` +
        `${result.events} new event(s)` +
        (result.reorg ? " (after reorg rollback)" : "")
    );
  }

  return result;
};

async function main() {
  if (!command || !["sync", "watch", "status", "rebuild"].includes(command)) {
    console.error("Usage: node src/indexer/cli.js <sync|watch|status|rebuild>");
    process.exitCode = 1;
    return;
  }

  // `status` reads the database only; it must work with no RPC configured.
  const { config, indexer, prisma } = createRuntime({
    requireRpc: command !== "status",
  });

  if (command === "status") {
    const { createIndexer } = require("./indexer");
    const readOnly =
      indexer || createIndexer({ prisma, reader: null, config, logger: console });
    printStatus(await readOnly.status());
    return;
  }

  if (command === "sync") {
    await runSync(indexer);
    return;
  }

  if (command === "rebuild") {
    if (!hasFlag("--confirm")) {
      console.error("Refusing to rebuild without --confirm.");
      console.error(
        "This DELETES every indexed event, split, round and checkpoint for"
      );
      console.error(
        `factory ${config.factoryAddress} on chain ${config.chainId}, then`
      );
      console.error("re-indexes from block", config.deploymentBlock + ".");
      console.error("");
      console.error("  npm run indexer:rebuild -- --confirm");
      process.exitCode = 1;
      return;
    }

    if (
      process.env.NODE_ENV === "production" &&
      !hasFlag("--i-know-this-is-production")
    ) {
      console.error(
        "Refusing to rebuild in production without --i-know-this-is-production."
      );
      console.error(
        "The API will serve an empty index until the rebuild completes."
      );
      process.exitCode = 1;
      return;
    }

    console.log("[indexer] rebuilding from block", config.deploymentBlock);
    const result = await indexer.rebuild();
    console.log(`[indexer] rebuild complete: ${result.events} event(s)`);
    return;
  }

  // watch
  const pollMs = config.indexer.pollMs;
  console.log(`[indexer] watching, polling every ${pollMs}ms. Ctrl+C to stop.`);

  let stopping = false;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[indexer] ${signal} received, finishing current pass...`);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!stopping) {
    try {
      await runSync(indexer);
    } catch (error) {
      // A transient RPC failure must not kill a long-running process.
      console.error("[indexer] pass failed:", error.message || error);
      await indexer.recordError(error);
    }

    if (stopping) break;

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  console.log("[indexer] stopped.");
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
