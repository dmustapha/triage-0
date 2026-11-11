import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, STAGE0_PATH } from "../../src/catalog.js";
import { routeCase } from "../../src/router/route.js";
import { createInferenceLock } from "../../src/router/lock.js";
import { createFakeBackend } from "../../src/backends/fake.js";

const catalog = loadCatalog(STAGE0_PATH);
const req = { text: "she is coughing and cannot speak" };
const deps = (b: ReturnType<typeof createFakeBackend>, timeoutMs = 2000) => ({ backend: b, catalog, timeoutMs, lock: createInferenceLock() });
const good = '{"candidates":["choking","collapse_cpr"],"next_question_id":"choking_q1","confidence":"high"}';

test("valid output maps to ranked candidates and the catalogue's question text", async () => {
  const r = await routeCase(req, deps(createFakeBackend([good])));
  assert.equal(r.fallback, false);
  assert.deepEqual(r.candidates, [{ page_id: "choking", rank: 1 }, { page_id: "collapse_cpr", rank: 2 }]);
  assert.equal(r.next_question?.id, "choking_q1");
  assert.match(r.next_question!.text, /STAGE-0 STUB/);
  assert.equal(r.confidence, "high");
  assert.equal(r.backend, "qvac");
  assert.equal(typeof r.timing.total_ms, "number");
});
test("unknown page id -> fallback true, candidates empty", async () => {
  const r = await routeCase(req, deps(createFakeBackend(['{"candidates":["appendicitis"],"next_question_id":null,"confidence":"high"}'])));
  assert.equal(r.fallback, true);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.next_question, null);
});
test("unknown question id -> fallback true", async () => {
  const r = await routeCase(req, deps(createFakeBackend(['{"candidates":["choking"],"next_question_id":"made_up","confidence":"high"}'])));
  assert.equal(r.fallback, true);
});
test("confidence low -> fallback true even with valid candidates", async () => {
  const r = await routeCase(req, deps(createFakeBackend(['{"candidates":["choking"],"next_question_id":null,"confidence":"low"}'])));
  assert.equal(r.fallback, true);
  assert.equal(r.confidence, "low");
});
test("malformed JSON -> fallback true, no throw", async () => {
  const r = await routeCase(req, deps(createFakeBackend(["{not json"])));
  assert.equal(r.fallback, true);
});
test("backend error -> fallback true", async () => {
  const r = await routeCase(req, deps(createFakeBackend([new Error("boom")])));
  assert.equal(r.fallback, true);
});
test("hang -> fallback true after timeoutMs, and the next call is served", async () => {
  const b = createFakeBackend(["hang", '{"candidates":["seizure"],"next_question_id":null,"confidence":"high"}']);
  const d = deps(b, 200);
  const t0 = Date.now();
  const r1 = await routeCase(req, d);
  assert.equal(r1.fallback, true);
  assert.ok(Date.now() - t0 < 1000);
  const r2 = await routeCase(req, d);
  assert.equal(r2.fallback, false);
});
test("fifth concurrent caller gets fallback true (queue full) without waiting", async () => {
  const b = createFakeBackend(["hang", "hang", "hang", "hang", "hang", good]);
  const d = deps(b, 300);
  const t0 = Date.now();
  const all = Promise.all([1, 2, 3, 4, 5].map(() => routeCase(req, d)));
  const sixth = await routeCase(req, d);
  assert.equal(sixth.fallback, true);
  assert.ok(Date.now() - t0 < 250, "queue-full answer must not wait for the lock");
  const rs = await all;
  assert.equal(rs.filter((r) => r.fallback).length, 5);
});

test("the UNSURE sentinel is in the output schema and maps to fallback", async () => {
  const { buildOutputSchema, UNSURE } = await import("../../src/router/schema.js");
  const s = buildOutputSchema(catalog) as any;
  assert.ok(s.properties.candidates.items.enum.includes(UNSURE));
  const r = await routeCase({ text: "my wifi is slow" }, deps(createFakeBackend([`{"candidates":["${UNSURE}"],"next_question_id":null,"confidence":"high"}`])));
  assert.equal(r.fallback, true);
  assert.deepEqual(r.candidates, []);
});
test("UNSURE mixed with pages -> fallback true (doubt resolves upward)", async () => {
  const { UNSURE } = await import("../../src/router/schema.js");
  const r = await routeCase(req, deps(createFakeBackend([`{"candidates":["choking","${UNSURE}"],"next_question_id":null,"confidence":"high"}`])));
  assert.equal(r.fallback, true);
});
test("duplicate candidates are collapsed to one ranked entry", async () => {
  const r = await routeCase(req, deps(createFakeBackend(['{"candidates":["severe_bleeding","severe_bleeding","choking"],"next_question_id":null,"confidence":"high"}'])));
  assert.equal(r.fallback, false);
  assert.deepEqual(r.candidates, [{ page_id: "severe_bleeding", rank: 1 }, { page_id: "choking", rank: 2 }]);
});
