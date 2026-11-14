// File: tests/integration/http-validation.test.ts
// MODEL-FREE HTTP-contract gate: the "never crashes on bad input" defence. Boots the Express app on an
// ephemeral port and asserts every validation short-circuit (400/413) BEFORE any inference can run — so
// no model is loaded and the single-writer RAG store is never touched. Each rejection path returns a
// FRIENDLY, fixed message (no raw paths), and the server stays up after a malformed-JSON request.
//
// Why no model is needed: every assertion here hits a guard that returns before withInferenceLock()
// (empty/oversized body, malformed JSON, no file, oversized upload). The one request that reaches a
// handler — GET /health — only calls chunkCount()/citationMapHealthy(), which read the sidecar, never a
// model. We deliberately never POST a VALID /triage or /tts body, so inference is never triggered.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Import the app WITHOUT pre-warm: app.listen(0) below does not pre-warm (only startServer on a real
// port does), so importing `app` directly keeps this suite model-free.
const { app } = await import("../../src/server.js");

let server: { address(): { port: number } | string | null; close(): void };
let base = "";

before(async () => {
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready()) as never;
  });
  const addr = (server as { address(): { port: number } }).address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => {
  if (server) server.close();
});

const postJson = (path: string, body: unknown, raw = false) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });

// ── /triage validation (short-circuits before inference) ───────────────────────────
test("POST /triage with empty caseText -> 400 'caseText is required.'", async () => {
  const r = await postJson("/triage", { caseText: "" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "caseText is required." });
});

test("POST /triage with whitespace-only caseText -> 400 (trimmed to empty)", async () => {
  const r = await postJson("/triage", { caseText: "    \n\t  " });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "caseText is required." });
});

test("POST /triage with a missing body field -> 400 'caseText is required.'", async () => {
  const r = await postJson("/triage", { notCaseText: "hello" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "caseText is required." });
});

test("POST /triage over 2000 chars -> 400 friendly 'too long' (no embedder overflow)", async () => {
  const r = await postJson("/triage", { caseText: "a".repeat(2001) });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /too long/i);
  assert.doesNotMatch(j.error, /\//, "friendly message leaks no path");
});

// ── /tts validation (short-circuits before inference) ──────────────────────────────
test("POST /tts with empty text -> 400 'text is required.'", async () => {
  const r = await postJson("/tts", { text: "" });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "text is required." });
});

test("POST /tts over 1000 chars -> 400 'too long to read aloud'", async () => {
  const r = await postJson("/tts", { text: "a".repeat(1001) });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, "Text is too long to read aloud. Please shorten it.");
});

// ── /transcribe validation (no file -> 400, short-circuits before inference) ────────
test("POST /transcribe with no file -> 400 'No audio uploaded'", async () => {
  // multipart with a text field but no "audio" file part — multer parses it, req.file is undefined,
  // the handler returns its 400. (An upload in the WRONG field is a different case — a MulterError now
  // mapped to 400 "Invalid file upload." by the centralised handler — covered separately below.)
  const fd = new FormData();
  fd.append("note", "no file here");
  const r = await fetch(`${base}/transcribe`, { method: "POST", body: fd });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "No audio uploaded (field 'audio')." });
});

test("POST /transcribe with a file in the wrong field -> 400 (MulterError, friendly)", async () => {
  const fd = new FormData();
  fd.append("notaudio", new Blob([new Uint8Array([1, 2, 3])]), "x.bin");
  const r = await fetch(`${base}/transcribe`, { method: "POST", body: fd });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "Invalid file upload." });
});

test("POST /transcribe with an oversized file -> 413 (multer 10MB limit, friendly)", async () => {
  // 11 MB > the 10 MB multer limit -> LIMIT_FILE_SIZE -> centralised handler -> 413.
  const big = new Uint8Array(11 * 1024 * 1024);
  const fd = new FormData();
  fd.append("audio", new Blob([big]), "big.bin");
  const r = await fetch(`${base}/transcribe`, { method: "POST", body: fd });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "Audio file is too large (max 10 MB)." });
});

// ── body-parser edge cases (centralised error middleware) ──────────────────────────
test("malformed JSON body -> 400 'Malformed JSON body.'", async () => {
  const r = await postJson("/triage", "{ not: valid json ", true);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "Malformed JSON body." });
});

test("oversized JSON body (> 256kb express limit) -> 413 'Request body is too large.'", async () => {
  // A single JSON string field over 256kb trips entity.too.large in body-parser BEFORE the route.
  const huge = JSON.stringify({ caseText: "a".repeat(300 * 1024) });
  const r = await postJson("/triage", huge, true);
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: "Request body is too large." });
});

// ── survival: the server stays up after a bad request ───────────────────────────────
test("GET /health returns 200 AFTER a malformed-JSON request (server survives bad input)", async () => {
  // Hit the centralised error path first...
  const bad = await postJson("/triage", "{ broken ", true);
  assert.equal(bad.status, 400);
  // ...then prove the process is still serving. /health reads chunkCount()/citationMapHealthy() only.
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.ok, true);
  assert.equal(typeof h.citationMapHealthy, "boolean", "health exposes citationMapHealthy boolean");
  assert.ok("chunks" in h, "health reports chunk count");
  assert.ok("residentModels" in h, "health reports resident models");
  assert.ok("residentMode" in h, "health reports resident mode");
  assert.ok("medpsy" in h, "health reports the medpsy variant");
});
