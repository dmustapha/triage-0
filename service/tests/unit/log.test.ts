import { test } from "node:test";
import assert from "node:assert/strict";
import { log, MAX_STRING_LEN } from "../../src/log.js";

function capture(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  (process.stderr as any).write = (chunk: string) => { out += chunk; return true; };
  try { fn(); } finally { (process.stderr as any).write = orig; }
  return out;
}

test("log.info throws on forbidden keys text/body/prompt/output", () => {
  for (const k of ["text", "body", "prompt", "output"]) {
    assert.throws(() => log.info("x", { [k]: 1 }), /never logged/);
  }
});
test("log.info throws on a string value longer than 64 chars", () => {
  assert.equal(MAX_STRING_LEN, 64);
  assert.throws(() => log.info("x", { route: "a".repeat(65) }), /too long/);
  capture(() => log.info("x", { route: "a".repeat(64) }));
});
test("log.info throws on a string field not on the allowlist", () => {
  assert.throws(() => log.info("x", { user: "zebra" }), /allowlist/);
});
test("log.error writes error name and status only, never err.message", () => {
  const out = capture(() => log.error("request_failed", new Error("the case said zebra umbrella 4471"), { status: 500 }));
  const rec = JSON.parse(out.trim());
  assert.equal(rec.error, "Error");
  assert.equal(rec.status, 500);
  assert.ok(!out.includes("zebra"));
  assert.ok(!("message" in rec));
});
