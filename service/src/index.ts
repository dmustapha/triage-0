import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { log } from "./log.js";
import { loadCatalog, STAGE0_PATH } from "./catalog.js";
import { routeCase } from "./router/route.js";
import { createInferenceLock } from "./router/lock.js";
import { createQvacBackend } from "./backends/qvac.js";
import { createLlamaCppBackend } from "./backends/llamacpp.js";
import type { RouteBackend } from "./backends/types.js";

const config = loadConfig(process.env);
const catalog = loadCatalog(STAGE0_PATH);
const lock = createInferenceLock();

function pickBackend(): RouteBackend {
  if (config.backend === "qvac") return createQvacBackend({ model: config.model, ctxSize: 2048 });
  return createLlamaCppBackend({ baseUrl: config.llamaServerUrl, model: config.model });
}

const backend = pickBackend();
let ready = false;

const app = createApp({
  route: (req) => routeCase(req, { backend, catalog, timeoutMs: config.routeTimeoutMs, lock }),
  health: () => ({ ok: ready, backend: backend.name, model: backend.model }),
  corsOrigins: config.corsOrigins,
  rateLimitPerMin: config.rateLimitPerMin,
});

const server = app.listen(config.port, config.host, () => log.info("listening", { status: config.port }));
backend.start().then(() => { ready = true; log.info("backend_ready", { backend: backend.name, model: backend.model }); })
  .catch((err: Error) => { log.error("backend_start_failed", { route: err.name }); process.exit(1); });

async function shutdown(): Promise<void> {
  server.close();
  await backend.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
