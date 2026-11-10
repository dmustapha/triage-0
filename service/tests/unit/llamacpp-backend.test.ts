import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlamaCppBackend } from "../../src/backends/llamacpp.js";

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const args = { system: "s", user: "u", jsonSchema: { type: "object" }, maxTokens: 160, signal: new AbortController().signal };

test("complete() posts response_format json_schema and returns message.content", async () => {
  const { f, calls } = fakeFetch((c) =>
    c.url.endsWith("/health") ? json({ status: "ok" }) :
    json({ choices: [{ message: { content: '{"candidates":["choking"]}' } }], timings: { predicted_per_second: 12.5 } }));
  const b = createLlamaCppBackend({ baseUrl: "http://127.0.0.1:8081", model: "medpsy-4b", fetchImpl: f });
  await b.start();
  const r = await b.complete(args);
  assert.equal(r.text, '{"candidates":["choking"]}');
  assert.equal(r.tokensPerS, 12.5);
  assert.equal(r.ttftMs, null);
  const post = calls.find((c) => c.url.endsWith("/v1/chat/completions"))!;
  const body = JSON.parse(post.init!.body as string);
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "route", schema: { type: "object" } } });
  assert.equal(body.max_tokens, 160);
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
  assert.equal(b.name, "llamacpp");
});

test("start() throws when /health is not 200", async () => {
  const { f } = fakeFetch(() => json({ error: "loading" }, 503));
  const b = createLlamaCppBackend({ baseUrl: "http://127.0.0.1:8081", model: "medpsy-4b", fetchImpl: f });
  await assert.rejects(() => b.start(), /health/);
});

test("complete() aborts on signal and surfaces an error", async () => {
  const { f } = fakeFetch((c) => {
    if (c.url.endsWith("/health")) return json({ status: "ok" });
    return new Promise<Response>((_, rej) => c.init!.signal!.addEventListener("abort", () => rej(c.init!.signal!.reason)));
  });
  const b = createLlamaCppBackend({ baseUrl: "http://127.0.0.1:8081", model: "medpsy-1.7b", fetchImpl: f });
  await b.start();
  const ac = new AbortController();
  const p = b.complete({ ...args, signal: ac.signal });
  ac.abort(new Error("timed out"));
  await assert.rejects(p, /timed out/);
});
