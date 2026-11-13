import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, parseOutDir, type BenchRow } from "../../src/bench/summarize.js";

const row = (p: Partial<BenchRow>): BenchRow => ({ backend: "llamacpp", model: "medpsy-4b", case: "c1", run: 1, ttft_ms: null, total_ms: 1000, tokens_per_s: 4, top1: "choking", fallback: false, reason: null, correct: true, heldout: false, ...p });

test("summarize reports first-sight (run 1) and warm-repeat p50 separately", () => {
  const rows = [row({ run: 1, total_ms: 6000 }), row({ run: 2, total_ms: 4000 }), row({ run: 3, total_ms: 4000 }),
                row({ case: "c2", run: 1, total_ms: 6200 }), row({ case: "c2", run: 2, total_ms: 4100 }), row({ case: "c2", run: 3, total_ms: 4100 })];
  const s = summarize(rows, "llamacpp", "medpsy-4b");
  assert.equal(s.firstSight.p50, 6200);
  assert.equal(s.warm.p50, 4100);
  assert.equal(s.firstSight.n, 2);
});
test("hit rate counts a case only if every run was correct, split tuned vs held-out", () => {
  const rows = [row({ case: "c1", run: 1 }), row({ case: "c1", run: 2, correct: false }), row({ case: "h1", run: 1, heldout: true }), row({ case: "h1", run: 2, heldout: true })];
  const s = summarize(rows, "llamacpp", "medpsy-4b");
  assert.deepEqual(s.hits.tuned, { hit: 0, of: 1 });
  assert.deepEqual(s.hits.heldout, { hit: 1, of: 1 });
});
test("parseOutDir defaults to bench/ when --out is absent and never returns argv[0]", () => {
  assert.equal(parseOutDir(["/usr/bin/node", "bench.ts"]), "bench/");
  assert.equal(parseOutDir(["/usr/bin/node", "bench.ts", "--out", "/tmp/x/"]), "/tmp/x/");
});
