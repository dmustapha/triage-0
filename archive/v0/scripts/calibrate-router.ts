/**
 * Off-domain threshold calibration for the Phase-2 semantic class-router (src/triage/class-router.ts).
 *
 * Hits the model-free /debug/route endpoint (server must run with TRIAGE0_DEBUG_ROUTE=1) for every
 * textbook + failure case and prints the best class-descriptor cosine + top-3 shortlist. The goal is to
 * pick ROUTER_OFF_DOMAIN so that:
 *   • the textbook ABSTAIN cases (A1 adult cardiac, A2 non-medical, A3 veterinary) fall BELOW it, and
 *   • the in-domain clinical cases (textbook R/D/F/E/M/J/MH + failure V/MS/CB, and RA/NE where reachable)
 *     stay ABOVE it.
 * RA7 (PTSD, no encoded class) is expected to abstain today — a low best-cosine there is desirable.
 *
 * Run: TRIAGE0_DEBUG_ROUTE=1 PORT=3010 MODEL_ID=1.7b npm start   (in one shell)
 *      npx tsx scripts/calibrate-router.ts                        (in another)
 */
import { textbookCases, failureCases, type TestCase } from "./audit-cases.js";

const BASE = process.env.TRIAGE0_BASE ?? "http://localhost:3010";

async function route(caseText: string): Promise<{ best: number; offDomain: boolean; shortlist: { cls: string; score: number }[] }> {
  const res = await fetch(`${BASE}/debug/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseText }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ best: number; offDomain: boolean; shortlist: { cls: string; score: number }[] }>;
}

/** Is this case one where abstain is the CORRECT behaviour? (textbook A-cases + RA7 PTSD gap.) */
function shouldAbstain(c: TestCase): boolean {
  return c.shouldAbstain === true;
}

async function main() {
  const cases = [...textbookCases, ...failureCases];
  const rows: { name: string; best: number; abstainWanted: boolean; top: string }[] = [];

  for (const c of cases) {
    try {
      const r = await route(c.input);
      const top = r.shortlist.slice(0, 3).map((s) => `${s.cls}=${s.score.toFixed(3)}`).join("  ");
      rows.push({ name: c.name, best: r.best, abstainWanted: shouldAbstain(c), top });
    } catch (e) {
      rows.push({ name: c.name, best: NaN, abstainWanted: shouldAbstain(c), top: `ERROR ${(e as Error).message}` });
    }
  }

  // Print grouped, sorted by best desc.
  const fmt = (r: typeof rows[number]) =>
    `${r.abstainWanted ? "🛑" : "  "} ${r.best.toFixed(3)}  ${r.name.padEnd(48)}  ${r.top}`;

  console.log("\n=== ALL CASES (sorted by best cosine, desc) ===");
  for (const r of [...rows].sort((a, b) => b.best - a.best)) console.log(fmt(r));

  // Separation summary.
  const abstain = rows.filter((r) => r.abstainWanted && Number.isFinite(r.best));
  const inDomain = rows.filter((r) => !r.abstainWanted && Number.isFinite(r.best));
  const maxAbstain = Math.max(...abstain.map((r) => r.best));
  const minInDomain = Math.min(...inDomain.map((r) => r.best));
  console.log("\n=== SEPARATION ===");
  console.log(`Abstain cases (want BELOW threshold): highest best = ${maxAbstain.toFixed(3)} (${abstain.find((r) => r.best === maxAbstain)?.name})`);
  console.log(`In-domain cases (want ABOVE threshold): lowest best = ${minInDomain.toFixed(3)} (${inDomain.find((r) => r.best === minInDomain)?.name})`);
  const gap = minInDomain - maxAbstain;
  console.log(gap > 0
    ? `CLEAN SEPARATION: gap = ${gap.toFixed(3)}. Suggested ROUTER_OFF_DOMAIN = ${((maxAbstain + minInDomain) / 2).toFixed(3)}`
    : `OVERLAP of ${(-gap).toFixed(3)} — no single threshold separates all. Inspect the offenders above.`);

  // List the lowest in-domain cases (most at risk of false-abstain) and the highest abstain cases.
  console.log("\nLowest in-domain (false-abstain risk):");
  for (const r of inDomain.sort((a, b) => a.best - b.best).slice(0, 6)) console.log(`  ${r.best.toFixed(3)}  ${r.name}`);
  console.log("Highest abstain-wanted (false-accept risk):");
  for (const r of abstain.sort((a, b) => b.best - a.best).slice(0, 6)) console.log(`  ${r.best.toFixed(3)}  ${r.name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
