/**
 * Clinical Quality Audit — direct API test runner.
 * Sends each case to the /triage SSE endpoint, parses the response,
 * and validates classification, severity, and plan completeness.
 * No browser needed — uses fetch + SSE parsing.
 */
import { setGlobalDispatcher, Agent } from "undici";
import { type TestCase, textbookCases, failureCases } from "./audit-cases.js";
setGlobalDispatcher(new Agent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 30_000 }));

const BASE = process.env.TRIAGE0_BASE ?? "http://localhost:3010";
// Case-set selector (CLI arg 1): "failure" | "textbook" | "all" (default). Lets the A/B run the
// failure-class set alone for clean before/after numbers without the textbook regression noise.
const CASE_SET = (process.argv[2] ?? "all").toLowerCase();
const cases: TestCase[] =
  CASE_SET === "failure" ? failureCases :
  CASE_SET === "textbook" ? textbookCases :
  [...textbookCases, ...failureCases];

interface TriageResult {
  caseName: string;
  classification: string;
  severity: string;
  action: string;
  medicines: string[];
  citation: string;
  planComponents: string[];
  error: string | null;
  ttftMs: number;
}

// TestCase + the case arrays now live in ./audit-cases.ts (imported above).


async function runTriage(caseText: string): Promise<TriageResult> {
  const res = await fetch(`${BASE}/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseText }),
    signal: AbortSignal.timeout(600_000), // 10 min per case
  });

  if (!res.ok) {
    return { caseName: "", classification: "", severity: "", action: "", medicines: [], citation: "", planComponents: [], error: `HTTP ${res.status}`, ttftMs: 0 };
  }

  // Use streaming reader — res.text() hangs on long-lived SSE streams with undici
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let chunks = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) chunks += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  const events = parseSSE(chunks);

  const cardEvent = events.find((e) => e.event === "card");
  const planEvent = events.find((e) => e.event === "plan");
  const citationEvent = events.find((e) => e.event === "citation");
  const firstTokenEvent = events.find((e) => e.event === "first_token");
  const errorEvent = events.find((e) => e.event === "error");
  const abstainEvent = events.find((e) => e.event === "abstain");

  if (errorEvent) {
    return { caseName: "", classification: "", severity: "", action: "", medicines: [], citation: "", planComponents: [], error: errorEvent.data?.error ?? "unknown", ttftMs: 0 };
  }

  if (abstainEvent) {
    return { caseName: "", classification: "UNKNOWN", severity: "UNKNOWN", action: "", medicines: [], citation: "", planComponents: [], error: null, ttftMs: 0 };
  }

  const card = cardEvent?.data?.card ?? {};
  const plan = planEvent?.data?.plan ?? {};
  const citation = citationEvent?.data;

  return {
    caseName: "",
    classification: card.classification ?? card.dx ?? cardEvent?.data?.classification ?? "",
    severity: card.severity ?? "",
    action: card.action ?? "",
    medicines: (plan.medicines ?? []).map((m: any) => m.name ?? ""),
    citation: citation ? `${citation.doc} p.${citation.page}` : "",
    planComponents: [
      plan.medicines?.length ? "medicines" : "",
      plan.supportive?.length ? "supportive" : "",
      plan.home_care?.length ? "home_care" : "",
      plan.return_now?.length ? "return_now" : "",
      plan.follow_up ? "follow_up" : "",
      plan.referral ? "referral" : "",
    ].filter(Boolean),
    error: null,
    ttftMs: firstTokenEvent?.data?.ttftMs ?? 0,
  };
}

function parseSSE(text: string): { event: string; data: any }[] {
  const events: { event: string; data: any }[] = [];
  const lines = text.split("\n");
  let currentEvent = "";
  let currentData = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      if (currentEvent && currentData) {
        try { events.push({ event: currentEvent, data: JSON.parse(currentData) }); } catch {}
      }
      currentEvent = line.slice(7).trim();
      currentData = "";
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentEvent && currentData) {
      try { events.push({ event: currentEvent, data: JSON.parse(currentData) }); } catch {}
      currentEvent = "";
      currentData = "";
    }
  }
  if (currentEvent && currentData) {
    try { events.push({ event: currentEvent, data: JSON.parse(currentData) }); } catch {}
  }
  return events;
}

interface Result {
  name: string;
  classification: string;
  severity: string;
  medicines: string[];
  planComponents: string[];
  citation: string;
  ttftMs: number;
  error: string | null;
  passed: boolean;
  failures: string[];
  expectedSeverity?: string | RegExp;
  expectedClassification?: string | RegExp;
}

async function main() {
  console.log("=== Triage-0 Clinical Quality Audit ===\n");

  // Verify server
  try {
    const h = await fetch(`${BASE}/health`);
    const hj = await h.json();
    console.log(`Server: ${hj.medpsy} model, ${hj.chunks} chunks, ${hj.residentModels.join(", ")} loaded\n`);
  } catch {
    console.error("ERROR: Server not reachable at", BASE);
    process.exit(1);
  }

  // Load prior results for resumption
  const fs = await import("fs");
  const RESULTS_PATH = process.env.TRIAGE0_RESULTS ?? "tests/quality/results.json";
  let results: Result[] = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;
  const completed: Set<string> = new Set();

  if (fs.existsSync(RESULTS_PATH)) {
    try {
      const prior = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf-8"));
      if (prior.results) {
        for (const r of prior.results) {
          completed.add(r.name);
          results.push(r);
          if (r.error) errors++;
          else if (r.passed) passed++;
          else failed++;
        }
        console.log(`Resuming: ${completed.size} cases already completed, ${passed} passed, ${failed} failed, ${errors} errors\n`);
      }
    } catch { /* ignore corrupt prior file */ }
  }

  const saveResults = () => {
    const out = { timestamp: new Date().toISOString(), total: results.length, passed, failed, errors, passRate: results.length > 0 ? (passed / results.length * 100).toFixed(1) : "0.0", results };
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
  };

  for (const c of cases) {
    if (completed.has(c.name)) {
      console.log(`${c.name}... SKIP (already done)`);
      continue;
    }
    process.stdout.write(`${c.name}... `);
    const start = Date.now();
    const r = await runTriage(c.input);
    const elapsed = Date.now() - start;

    if (r.error) {
      console.log(`ERROR (${r.error})`);
      errors++;
      results.push({ name: c.name, classification: "ERROR", severity: "ERROR", medicines: [], planComponents: [], citation: "", ttftMs: elapsed, error: r.error, passed: false, failures: [r.error] });
      saveResults();
      continue;
    }

    const failures: string[] = [];

    // Severity check
    if (c.expectedSeverity) {
      if (c.expectedSeverity instanceof RegExp) {
        if (!c.expectedSeverity.test(r.severity)) failures.push(`severity: got ${r.severity}, expected match ${c.expectedSeverity}`);
      } else {
        if (r.severity !== c.expectedSeverity) failures.push(`severity: got ${r.severity}, expected ${c.expectedSeverity}`);
      }
    }

    // Classification check
    if (c.expectedClassification) {
      const clsUpper = r.classification.toUpperCase();
      if (c.expectedClassification instanceof RegExp) {
        if (!c.expectedClassification.test(clsUpper)) failures.push(`classification: got ${r.classification}, expected match ${c.expectedClassification}`);
      } else {
        if (!clsUpper.includes(c.expectedClassification.toString().toUpperCase())) failures.push(`classification: got ${r.classification}, expected ${c.expectedClassification}`);
      }
    }

    // Should NOT classification check. Negation-aware: "FEVER: NO MALARIA" is a DISTINCT class that is
    // clinically NOT malaria, so a bare substring match on "MALARIA" would wrongly fail it. Only flag when
    // the forbidden term appears as a POSITIVE classification (not inside a "NO <term>" negative).
    if (c.shouldNotBeClassification) {
      const clsU = r.classification.toUpperCase();
      const term = c.shouldNotBeClassification.toUpperCase();
      if (clsU.includes(term) && !clsU.includes(`NO ${term}`)) {
        failures.push(`classification: should NOT be ${c.shouldNotBeClassification}, got ${r.classification}`);
      }
    }

    // Abstain check
    if (c.shouldAbstain) {
      if (r.severity !== "UNKNOWN") failures.push(`abstain: expected UNKNOWN, got ${r.severity}`);
    }

    // Medicines check
    if (c.shouldHaveMeds && r.medicines.length === 0) {
      failures.push("medicines: expected at least one, got none");
    }

    const isPass = failures.length === 0;
    if (isPass) {
      console.log(`PASS (${r.severity} ${r.classification}, ${elapsed / 1000}s)`);
      passed++;
    } else {
      console.log(`FAIL [${failures.join("; ")}] (${r.severity} ${r.classification}, ${elapsed / 1000}s)`);
      failed++;
    }

    results.push({
      name: c.name,
      classification: r.classification,
      severity: r.severity,
      medicines: r.medicines,
      planComponents: r.planComponents,
      citation: r.citation,
      ttftMs: r.ttftMs,
      error: null,
      passed: isPass,
      failures,
      expectedSeverity: c.expectedSeverity,
      expectedClassification: c.expectedClassification,
    });
    saveResults();
  }

  // ── Summary ──
  const total = results.length;
  console.log(`\n=== Results: ${passed}/${total} passed, ${failed} failed, ${errors} errors ===`);
  console.log(`Pass rate: ${((passed / total) * 100).toFixed(1)}%`);

  // Per-category breakdown
  const cats: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    // Group by the alphabetic case-family prefix: "V1"→"V", "MS1"→"MS", "CB2"→"CB", "RA3"→"RA",
    // "NE1"→"NE", textbook "R1"→"R". For the failure set these families ARE the failure classes.
    const cat = r.name.split(" — ")[0].replace(/\d+$/, "").trim();
    if (!cats[cat]) cats[cat] = { total: 0, passed: 0 };
    cats[cat].total++;
    if (r.passed) cats[cat].passed++;
  }
  console.log("\nPer-category:");
  for (const [cat, stats] of Object.entries(cats)) {
    console.log(`  ${cat}: ${stats.passed}/${stats.total} (${((stats.passed / stats.total) * 100).toFixed(0)}%)`);
  }

  // Classification accuracy (non-abstain cases)
  const clinicalCases = results.filter((r) => !r.name.includes("abstain") && !r.name.startsWith("A") && !r.error);
  const correctClass = clinicalCases.filter((r) => !r.failures.some((f) => f.startsWith("classification")));
  console.log(`\nClassification accuracy: ${correctClass.length}/${clinicalCases.length} (${((correctClass.length / clinicalCases.length) * 100).toFixed(0)}%)`);

  // Severity correctness
  const correctSev = clinicalCases.filter((r) => !r.failures.some((f) => f.startsWith("severity")));
  console.log(`Severity correctness: ${correctSev.length}/${clinicalCases.length} (${((correctSev.length / clinicalCases.length) * 100).toFixed(0)}%)`);

  // Abstain rate
  const abstainCases = results.filter((r) => r.name.includes("abstain") || r.name.startsWith("A"));
  const correctAbstain = abstainCases.filter((r) => r.passed);
  console.log(`Abstain accuracy: ${correctAbstain.length}/${abstainCases.length} (${((correctAbstain.length / abstainCases.length) * 100).toFixed(0)}%)`);

  saveResults();
  console.log("\nResults written to tests/quality/results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
