// File: src/qvac/perf-logger.ts
// The auditable perf log is a SCORED submission artifact (Downstream D2). One row is
// appended to perf-log.csv AND perf-log.json on EVERY inference event, from commit 1.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type PerfEvent =
  | "load"
  | "unload"
  | "completion"
  | "transcribe"
  | "embed"
  | "search"
  | "tts";

export interface PerfLogRow {
  ts: string; // ISO8601
  phase: string; // e.g. "transcribe" | "triage" | "tts" | "ingest" | "spike"
  event: PerfEvent;
  modelId: string;
  promptTokens?: number; // approx prompt token count (chars/4) when known
  ttftMs?: number; // timeToFirstToken from final.stats
  tokensPerSec?: number; // tokensPerSecond from final.stats
  totalTokens?: number; // totalTokens from final.stats
  backendDevice?: string; // e.g. "gpu"
  durationMs: number; // wall-clock via performance.now()
}

// Paths are resolved lazily against TRIAGE0_PERF_DIR (defaults to cwd) so tests can redirect
// output to a temp dir without polluting the repo. The app always runs from triage-0/.
const perfDir = () => process.env.TRIAGE0_PERF_DIR ?? process.cwd();
const csvPath = () => resolve(perfDir(), "perf-log.csv");
const jsonlPath = () => resolve(perfDir(), "perf-log.jsonl");
const jsonPath = () => resolve(perfDir(), "perf-log.json");
const HEADER =
  "ts,phase,event,modelId,promptTokens,ttftMs,tokensPerSec,totalTokens,backendDevice,durationMs\n";

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowToCsv(r: PerfLogRow): string {
  return [
    r.ts, r.phase, r.event, r.modelId, r.promptTokens, r.ttftMs,
    r.tokensPerSec, r.totalTokens, r.backendDevice, r.durationMs,
  ].map(csvCell).join(",") + "\n";
}

/**
 * Append one row to perf-log.csv AND perf-log.jsonl. Called on EVERY event.
 * Both are append-only single-line writes (atomic on local FS for small payloads), so the two
 * artifacts stay consistent even under concurrent/interleaved calls — unlike the previous
 * whole-array JSON rewrite, which was O(n²) and dropped rows when calls interleaved.
 */
export function logPerf(row: PerfLogRow): void {
  const csv = csvPath();
  if (!existsSync(csv)) writeFileSync(csv, HEADER, "utf8");
  appendFileSync(csv, rowToCsv(row), "utf8");
  appendFileSync(jsonlPath(), JSON.stringify(row) + "\n", "utf8");
}

export function readPerfRows(): PerfLogRow[] {
  const jsonl = jsonlPath();
  if (!existsSync(jsonl)) return [];
  return readFileSync(jsonl, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PerfLogRow;
      } catch {
        return null;
      }
    })
    .filter((r): r is PerfLogRow => r !== null);
}

/**
 * Render perf-log.json (a pretty array) from the JSONL spine — for the submission bundle, which
 * wants a structured csv/json log. Call once at clean shutdown / snapshot time, NOT per event.
 */
export function snapshotPerfJson(): string {
  const p = jsonPath();
  writeFileSync(p, JSON.stringify(readPerfRows(), null, 2), "utf8");
  return p;
}

export function perfCsvPath(): string {
  return csvPath();
}

export function perfJsonlPath(): string {
  return jsonlPath();
}
