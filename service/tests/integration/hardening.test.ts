import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, MSG } from "../../src/app.js";
import { routeCase } from "../../src/router/route.js";
import { createInferenceLock } from "../../src/router/lock.js";
import { loadCatalog, STAGE0_PATH } from "../../src/catalog.js";
import { createFakeBackend } from "../../src/backends/fake.js";
import { BIND_HOST } from "../../src/config.js";

const CASE = "zebra umbrella 4471";
let server: Server;
let base: string;
let stderr = "";
const origWrite = process.stderr.write.bind(process.stderr);

// 30 served + 1 from a second IP = 31 backend calls before the error-path call.
const script: (string | Error)[] = [];
for (let i = 0; i < 31; i++) script.push('{"candidates":["choking"],"next_question_id":null,"confidence":"high"}');
script.push(new Error(`backend blew up while reading: ${CASE}`));
const backend = createFakeBackend(script);

before(async () => {
  (process.stderr as any).write = (chunk: string) => { stderr += chunk; return true; };
  const catalog = loadCatalog(STAGE0_PATH);
  const app = createApp({
    route: (req) => routeCase(req, { backend, catalog, timeoutMs: 2000, lock: createInferenceLock() }),
    health: () => ({ ok: true, backend: "fake", model: "none" }),
    corsOrigins: ["https://triage-0.app"],
    rateLimitPerMin: 30,
  });
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); (process.stderr as any).write = origWrite; });

const post = (text: string, ip = "203.0.113.9") =>
  fetch(`${base}/route`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ text }) });

test("31st POST /route in a minute from one IP -> 429 with the fixed message; another IP still served", async () => {
  for (let i = 0; i < 30; i++) assert.equal((await post(CASE)).status, 200);
  const r = await post(CASE);
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: MSG.tooMany });
  assert.equal(MSG.tooMany, "Too many requests from this connection. If this is an emergency, call for an ambulance now.");
  assert.equal((await post(CASE, "198.51.100.7")).status, 200);
});

test("stderr across the success and error paths never contains the case text", async () => {
  const errPath = await post(CASE, "198.51.100.8");
  assert.equal(errPath.status, 200);
  assert.equal((await errPath.json()).fallback, true);
  assert.ok(stderr.length > 0, "something was logged");
  assert.ok(!stderr.includes(CASE), `case text leaked to stderr: ${stderr.slice(0, 200)}`);
  assert.ok(!stderr.includes("zebra"));
});

test("app binds only to 127.0.0.1 in index.ts", () => {
  assert.equal(BIND_HOST, "127.0.0.1");
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /app\.listen\(config\.port,\s*config\.host/);
  assert.ok(!/0\.0\.0\.0/.test(src));
});
