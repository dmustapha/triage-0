import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteResponseSchema, FALLBACK_REASONS } from "../../src/contract.js";
import { routeCase } from "../../src/router/route.js";
import { createInferenceLock } from "../../src/router/lock.js";
import { loadCatalog, STAGE0_PATH } from "../../src/catalog.js";
import { createFakeBackend } from "../../src/backends/fake.js";

const catalog = loadCatalog(STAGE0_PATH);
const deps = (b: ReturnType<typeof createFakeBackend>) => ({ backend: b, catalog, timeoutMs: 2000, lock: createInferenceLock() });

test("contract: fallback_reason is optional and enum-bound", () => {
  assert.ok(FALLBACK_REASONS.includes("unsure"));
  const base = { candidates: [], next_question: null, confidence: "low", fallback: true, timing: { ttft_ms: null, total_ms: 1, tokens_per_s: null }, backend: "qvac", model: "medpsy-4b" };
  assert.equal(RouteResponseSchema.safeParse(base).success, true);
  assert.equal(RouteResponseSchema.safeParse({ ...base, fallback_reason: "unsure" }).success, true);
  assert.equal(RouteResponseSchema.safeParse({ ...base, fallback_reason: "because" }).success, false);
});
test("routeCase sets fallback_reason=unsure when the model says unsure, parse_error on bad JSON, absent on success", async () => {
  const unsure = await routeCase({ text: "wifi slow" }, deps(createFakeBackend(['{"candidates":["unsure"],"confidence":"high"}'])));
  assert.equal(unsure.fallback_reason, "unsure");
  const bad = await routeCase({ text: "x" }, deps(createFakeBackend(["{nope"])));
  assert.equal(bad.fallback_reason, "parse_error");
  const ok = await routeCase({ text: "x" }, deps(createFakeBackend(['{"candidates":["choking"],"confidence":"high"}'])));
  assert.equal(ok.fallback_reason, undefined);
});
