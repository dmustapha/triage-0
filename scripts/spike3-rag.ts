// File: scripts/spike3-rag.ts
// Phase-1 reconciliation spike. Proves the REAL @qvac/rag native pipeline on this M1:
//   loadModel(GTE_LARGE_FP16, embeddings) -> ragChunk -> embed -> ragSaveEmbeddings(workspace) -> ragSearch
// Decides whether store.ts/ingest.ts use native HyperDB RAG (preferred) vs cosine-JS fallback.
// Run: npm run spike:rag   (node --import tsx scripts/spike3-rag.ts)
import * as qvac from "@qvac/sdk";
import { execSync } from "node:child_process";

const log = (...a: unknown[]) => console.log(...a);
const WORKSPACE = "triage0-spike";

// Real WHO-flavoured sample chunks (synthetic text, IMCI/mhGAP-shaped) so we can judge ranking.
const DOCS = [
  { id: "IMCI|p23|c0", protocol: "IMCI", page: 23,
    content: "Fast breathing in a child age 12 months up to 5 years is 40 breaths per minute or more. Chest indrawing or a respiratory rate of 50 or more in a 2 year old indicates severe pneumonia. Classify as PNEUMONIA and give first dose of oral amoxicillin; refer urgently if chest indrawing or any danger sign is present." },
  { id: "IMCI|p15|c0", protocol: "IMCI", page: 15,
    content: "General danger signs: the child is not able to drink or breastfeed, vomits everything, has had convulsions, or is lethargic or unconscious. A child with any general danger sign needs URGENT referral to hospital." },
  { id: "IMCI|p41|c0", protocol: "IMCI", page: 41,
    content: "Diarrhoea with sunken eyes, very slow skin pinch, and inability to drink is classified as SEVERE DEHYDRATION. Begin IV fluids immediately following Plan C and reassess the child frequently." },
  { id: "mhGAP|p67|c0", protocol: "mhGAP", page: 67,
    content: "In the assessment of depression, ask about persistent low mood, loss of interest, sleep disturbance, and thoughts of self-harm over at least two weeks. Assess suicide risk before deciding on management and follow-up." },
];

const workerRSS = () => {
  try {
    const out = execSync("ps -axo rss,command | grep -i 'qvac-worker\\|bare' | grep -v grep", { encoding: "utf8" });
    const kb = out.trim().split("\n").filter(Boolean).reduce((s, l) => s + parseInt(l.trim().split(/\s+/)[0] || "0", 10), 0);
    return Math.round(kb / 1024);
  } catch { return 0; }
};

(async () => {
  log("=== Triage-0 Phase-1 RAG reconciliation spike ===");
  log("rag exports present:", ["ragChunk","embed","ragSaveEmbeddings","ragSearch","ragListWorkspaces","ragDeleteWorkspace"]
    .map(k => `${k}:${typeof (qvac as any)[k]}`).join(" "));
  const GTE = (qvac as any).GTE_LARGE_FP16;
  log("GTE_LARGE_FP16 descriptor name:", GTE?.name);

  // 1) load embeddings model (descriptor overload -> modelType inferred)
  const tLoad = Date.now();
  const embedModelId: string = await (qvac as any).loadModel({ modelSrc: GTE, modelType: "embeddings" });
  log(`[1] embeddings loaded: modelId=${embedModelId} in ${Date.now() - tLoad}ms | worker RSS=${workerRSS()}MB`);

  // 2) chunk one doc via the SDK chunker (prove ragChunk shape), then we re-id deterministically
  const chunked = await (qvac as any).ragChunk({
    documents: [DOCS[0].content],
    chunkOpts: { chunkSize: 256, chunkOverlap: 50, chunkStrategy: "paragraph" },
  });
  log(`[2] ragChunk -> ${chunked.length} chunk(s); first keys=${Object.keys(chunked[0] ?? {})}`);

  // 3) embed all doc contents (segregated flow -> number[][])
  const tEmbed = Date.now();
  const emb = await (qvac as any).embed({ modelId: embedModelId, text: DOCS.map(d => d.content) });
  const vectors: number[][] = emb.embedding;
  log(`[3] embed -> ${vectors.length} vectors, dim=${vectors[0]?.length}, in ${Date.now() - tEmbed}ms, stats=${JSON.stringify(emb.stats ?? {})}`);

  // clean any prior spike workspace so the run is idempotent
  try { await (qvac as any).ragDeleteWorkspace({ workspace: WORKSPACE }); log("    (cleared prior spike workspace)"); } catch {}

  // 4) save embeddings with deterministic ids + citation metadata
  const documents = DOCS.map((d, i) => ({
    id: d.id, content: d.content, embedding: vectors[i], embeddingModelId: embedModelId,
    metadata: { protocol: d.protocol, page: d.page },
  }));
  const saved = await (qvac as any).ragSaveEmbeddings({ workspace: WORKSPACE, documents });
  log(`[4] ragSaveEmbeddings -> ${JSON.stringify(saved).slice(0, 200)}`);

  // 5) search a symptom query -> expect the pneumonia chunk (IMCI|p23) ranked #1
  const query = "2 year old child fever fast breathing 55 per minute chest indrawing";
  const tSearch = Date.now();
  const results = await (qvac as any).ragSearch({ modelId: embedModelId, query, topK: 3, workspace: WORKSPACE });
  log(`[5] ragSearch("${query}") -> ${results.length} hits in ${Date.now() - tSearch}ms:`);
  for (const r of results) log(`     ${r.id ?? "(no id)"}  score=${typeof r.score === "number" ? r.score.toFixed(4) : r.score}  "${(r.content ?? "").slice(0, 60)}…"`);

  // 6) verdict: did search return ids (so citation sidecar by id works) and rank pneumonia first?
  const top = results[0];
  const idsReturned = results.every((r: any) => typeof r.id === "string" && r.id.length);
  const correctTop = top?.id === "IMCI|p23|c0" || (top?.content ?? "").includes("Fast breathing");
  log("\n=== VERDICT ===");
  log(`ids round-trip through ragSearch: ${idsReturned ? "YES (citation-by-id works)" : "NO (need content-hash sidecar)"}`);
  log(`pneumonia chunk ranked #1: ${correctTop ? "YES (semantic ranking real)" : "NO -- inspect scores"}`);

  // 7) disk persistence: where does the workspace live?
  try {
    const ls = execSync("ls -la . ; echo '---'; find . -maxdepth 3 -newermt '-2 minutes' -type d 2>/dev/null | grep -vi node_modules | head -20", { encoding: "utf8", cwd: process.cwd() });
    log("\n[7] cwd dirs after save (look for a store/corestore/.qvac dir):\n" + ls);
  } catch (e: any) { log("[7] disk scan failed:", e?.message); }

  try { await (qvac as any).ragDeleteWorkspace({ workspace: WORKSPACE }); } catch {}
  try { await (qvac as any).unloadModel({ modelId: embedModelId }); } catch {}
  try { (qvac as any).close?.(); } catch {}
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
})().catch(e => { console.error("SPIKE ERROR:", e?.stack || e); process.exit(1); });
