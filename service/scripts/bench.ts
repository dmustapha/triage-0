/**
 * Stage 0 benchmark. Runs on the box: for each backend × model, warm once, then every case ×3.
 * Usage: BENCH_COMBOS="qvac:medpsy-4b,llamacpp:medpsy-4b" npx tsx scripts/bench.ts --out bench/
 * Model process switching (systemctl) is done by the caller between combos; this script runs one combo per
 * invocation when BENCH_COMBOS has one entry, and all when several (SDK combos load in-process).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadCatalog, STAGE0_PATH } from "../src/catalog.js";
import { routeCase } from "../src/router/route.js";
import { createInferenceLock } from "../src/router/lock.js";
import { createQvacBackend } from "../src/backends/qvac.js";
import { createLlamaCppBackend } from "../src/backends/llamacpp.js";
import type { ModelName, RouteBackend } from "../src/backends/types.js";

type Case = { id: string; text: string; expect: string | null };
type Row = { backend: string; model: string; case: string; run: number; ttft_ms: number | null; total_ms: number; tokens_per_s: number | null; top1: string; fallback: boolean; correct: boolean };

const outDir = process.argv[process.argv.indexOf("--out") + 1] || "bench/";
const runs = Number(process.env.BENCH_RUNS ?? 3);
const combos = (process.env.BENCH_COMBOS ?? "qvac:medpsy-4b").split(",").map((c) => c.split(":") as [string, ModelName]);
const cases: Case[] = JSON.parse(readFileSync(new URL("../bench/cases.json", import.meta.url), "utf8"));
const catalog = loadCatalog(STAGE0_PATH);
const lock = createInferenceLock();
const rows: Row[] = [];

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}
function rssMb(pattern: string): string {
  try { return execSync(`ps -C ${pattern} -o rss= | awk '{s+=$1} END {printf "%d", s/1024}'`).toString().trim() || "n/a"; } catch { return "n/a"; }
}

async function runCombo(backend: RouteBackend): Promise<void> {
  await backend.start();
  await routeCase({ text: cases[0].text }, { backend, catalog, timeoutMs: 120_000, lock }); // warm
  for (const c of cases) {
    for (let run = 1; run <= runs; run++) {
      const r = await routeCase({ text: c.text }, { backend, catalog, timeoutMs: 60_000, lock });
      const top1 = r.candidates[0]?.page_id ?? "(fallback)";
      const correct = c.expect === null ? r.fallback : top1 === c.expect && !r.fallback;
      rows.push({ backend: backend.name, model: backend.model, case: c.id, run, ttft_ms: r.timing.ttft_ms, total_ms: r.timing.total_ms, tokens_per_s: r.timing.tokens_per_s, top1, fallback: r.fallback, correct });
      process.stderr.write(`${backend.name}/${backend.model} ${c.id} r${run}: ${r.timing.total_ms} ms top1=${top1} ok=${correct}\n`);
    }
  }
  const rss = rssMb(backend.name === "qvac" ? "bare" : "llama-server");
  process.stderr.write(`RSS ${backend.name}/${backend.model}: ${rss} MB\n`);
  await backend.stop();
}

for (const [name, model] of combos) {
  const backend = name === "qvac"
    ? createQvacBackend({ model, ctxSize: 2048 })
    : createLlamaCppBackend({ baseUrl: process.env.LLAMA_SERVER_URL ?? "http://127.0.0.1:8081", model });
  await runCombo(backend);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const csv = ["backend,model,case,run,ttft_ms,total_ms,tokens_per_s,top1,fallback,correct", ...rows.map((r) => Object.values(r).join(","))].join("\n");
writeFileSync(`${outDir}/results-${stamp}.csv`, csv);

console.log("| backend | model | p50 total ms | p95 total ms | p50 ttft ms | tok/s (median) | top-1 hit rate |");
console.log("|---|---|---|---|---|---|---|");
for (const [name, model] of combos) {
  const rs = rows.filter((r) => r.backend === name && r.model === model);
  const totals = rs.map((r) => r.total_ms);
  const ttfts = rs.map((r) => r.ttft_ms).filter((x): x is number => x !== null);
  const tps = rs.map((r) => r.tokens_per_s).filter((x): x is number => x !== null);
  const perCase = cases.map((c) => rs.filter((r) => r.case === c.id).every((r) => r.correct));
  console.log(`| ${name} | ${model} | ${pct(totals, 50)} | ${pct(totals, 95)} | ${ttfts.length ? pct(ttfts, 50) : "n/a"} | ${tps.length ? pct(tps, 50).toFixed(1) : "n/a"} | ${perCase.filter(Boolean).length}/${cases.length} |`);
}
process.exit(0);
