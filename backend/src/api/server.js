// backend/src/api/server.js
//
// Process entry point for the API. Binds to API_HOST, which defaults to
// 127.0.0.1 so the service is never accidentally exposed; in production Nginx
// or Caddy terminates TLS and proxies to it.

const { buildApp } = require("./app");
const { createRuntime } = require("../runtime");
const { disconnectPrisma } = require("../db/client");

async function main() {
  const runtime = createRuntime({ requireRpc: false });
  const app = await buildApp({ runtime });

  const close = async (signal) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on("SIGINT", () => close("SIGINT"));
  process.on("SIGTERM", () => close("SIGTERM"));

  await app.listen({ host: runtime.config.api.host, port: runtime.config.api.port });

  app.log.info(
    `web3 API listening on http://${runtime.config.api.host}:${runtime.config.api.port}`
  );
}

main().catch(async (error) => {
  console.error(error.message || error);
  await disconnectPrisma();
  process.exitCode = 1;
});
