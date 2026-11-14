import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";

let server: Server;
let base: string;
const origins = ["https://triage-0.app"];

before(async () => {
  const app = createApp({
    route: async () => { throw new Error("route must not be called"); },
    health: () => ({ ok: true, backend: "fake", model: "none" }),
    corsOrigins: origins,
    rateLimitPerMin: 1000,
  });
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`${base}/route`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

test("POST /route with empty text -> 400 'Tell us what is happening.'", async () => {
  const r = await post(JSON.stringify({ text: "" }));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "Tell us what is happening." });
});
test("POST /route with 2001 chars -> 400 'That is too long. A sentence or two is enough.'", async () => {
  const r = await post(JSON.stringify({ text: "a".repeat(2001) }));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "That is too long. A sentence or two is enough." });
});
test("POST /route with malformed JSON -> 400 and server still answers GET /health", async () => {
  const r = await post("{not json");
  assert.equal(r.status, 400);
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 200);
});
test("POST /route with a 64 KB body -> 413", async () => {
  const r = await post(JSON.stringify({ text: "a".repeat(64 * 1024) }));
  assert.equal(r.status, 413);
});
test("GET /health returns only ok, backend, model keys", async () => {
  const body = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(Object.keys(body).sort(), ["backend", "model", "ok"]);
});
test("OPTIONS /route from a non-allowlisted origin has no Access-Control-Allow-Origin header", async () => {
  const r = await fetch(`${base}/route`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const ok = await fetch(`${base}/route`, { method: "OPTIONS", headers: { origin: origins[0] } });
  assert.equal(ok.headers.get("access-control-allow-origin"), origins[0]);
});

test("POST /route with an unsupported charset -> 415, not 500", async () => {
  const r = await fetch(`${base}/route`, { method: "POST", headers: { "content-type": "application/json; charset=klingon" }, body: JSON.stringify({ text: "he fell" }) });
  assert.equal(r.status, 415);
});
