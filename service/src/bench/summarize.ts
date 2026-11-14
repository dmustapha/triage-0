export type BenchRow = {
  backend: string; model: string; case: string; run: number;
  ttft_ms: number | null; total_ms: number; tokens_per_s: number | null;
  top1: string; fallback: boolean; reason: string | null; correct: boolean; heldout: boolean;
};

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

type Stats = { n: number; p50: number; p95: number };
const stats = (rows: BenchRow[]): Stats => ({ n: rows.length, p50: pct(rows.map((r) => r.total_ms), 50), p95: pct(rows.map((r) => r.total_ms), 95) });

function hitRate(rows: BenchRow[]): { hit: number; of: number } {
  const byCase = new Map<string, boolean>();
  for (const r of rows) byCase.set(r.case, (byCase.get(r.case) ?? true) && r.correct);
  return { hit: [...byCase.values()].filter(Boolean).length, of: byCase.size };
}

/** First-sight (run 1) is the honest latency: later runs of an identical prompt replay llama-server's full-prompt cache. */
export function summarize(rows: BenchRow[], backend: string, model: string) {
  const rs = rows.filter((r) => r.backend === backend && r.model === model);
  const tps = rs.map((r) => r.tokens_per_s).filter((x): x is number => x !== null);
  return {
    firstSight: stats(rs.filter((r) => r.run === 1)),
    warm: stats(rs.filter((r) => r.run > 1)),
    tokensPerS: tps.length ? pct(tps, 50) : null,
    hits: { tuned: hitRate(rs.filter((r) => !r.heldout)), heldout: hitRate(rs.filter((r) => r.heldout)) },
  };
}

export function parseOutDir(argv: string[]): string {
  const i = argv.indexOf("--out");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "bench/";
}

export function markdownRow(backend: string, model: string, s: ReturnType<typeof summarize>): string {
  const h = (x: { hit: number; of: number }) => (x.of ? `${x.hit}/${x.of}` : "n/a");
  return `| ${backend} | ${model} | ${s.firstSight.p50} | ${s.firstSight.p95} | ${s.warm.p50} | ${s.tokensPerS?.toFixed(1) ?? "n/a"} | ${h(s.hits.tuned)} | ${h(s.hits.heldout)} |`;
}
