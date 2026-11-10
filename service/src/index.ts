import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { log } from "./log.js";
import type { RouteRequest, RouteResponse } from "./contract.js";

const config = loadConfig(process.env);

// Stub until the router (Task 5) and backends (Tasks 4, 6) are wired.
async function route(_req: RouteRequest): Promise<RouteResponse> {
  return {
    candidates: [],
    next_question: null,
    confidence: "low",
    fallback: true,
    timing: { ttft_ms: null, total_ms: 0, tokens_per_s: null },
    backend: config.backend,
    model: config.model,
  };
}

const app = createApp({
  route,
  health: () => ({ ok: true, backend: config.backend, model: config.model }),
  corsOrigins: config.corsOrigins,
  rateLimitPerMin: config.rateLimitPerMin,
});

app.listen(config.port, config.host, () => log.info("listening", { status: config.port, route: config.host }));
