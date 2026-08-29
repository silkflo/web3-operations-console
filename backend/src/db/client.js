// backend/src/db/client.js
//
// Single PrismaClient for the process. Prisma lives ONLY under backend/src —
// importing it from pages/ or lib/ would ship a database driver to the browser.

const { PrismaClient } = require("@prisma/client");

let client = null;

const getPrisma = () => {
  if (!client) {
    client = new PrismaClient({
      log: process.env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
    });
  }

  return client;
};

const disconnectPrisma = async () => {
  if (client) {
    await client.$disconnect();
    client = null;
  }
};

module.exports = { getPrisma, disconnectPrisma };
