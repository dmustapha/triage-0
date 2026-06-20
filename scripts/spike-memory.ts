// File: scripts/spike-memory.ts
// [ASSUMED→to-verify] Phase-0 memory spike. Run: node --expose-gc --import tsx scripts/spike-memory.ts
// Decides RESIDENT_MODE: does unloadModel() return RAM to ~baseline?
import * as qvac from "@qvac/sdk";

const MODEL_PATH = process.env.MODEL_PATH
  || new URL("../.models/medpsy-1.7b-q4_k_m-imat.gguf", import.meta.url).pathname;

const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const gc = () => { if (global.gc) { global.gc(); global.gc(); } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(...a);

async function main() {
  log("=== Triage-0 Phase-0 memory spike ===");
  log("model:", MODEL_PATH);
  log("sdk exports loadModel/completion/unloadModel:",
    typeof qvac.loadModel, typeof qvac.completion, typeof qvac.unloadModel);
  gc(); await sleep(200);
  const base = rssMB();
  log(`[1] baseline RSS: ${base} MB`);

  // --- load ---
  const tLoad = Date.now();
  let modelId: any;
  try {
    modelId = await (qvac as any).loadModel({ modelSrc: MODEL_PATH, modelType: "llm", modelConfig: { ctx_size: 4096 } });
  } catch (e: any) {
    log("loadModel({modelType,modelConfig}) failed:", e?.message, "— retrying minimal shape");
    modelId = await (qvac as any).loadModel({ modelSrc: MODEL_PATH, modelType: "llm" });
  }
  log(`    modelId:`, typeof modelId === "object" ? JSON.stringify(modelId).slice(0,120) : modelId);
  const loadMs = Date.now() - tLoad;
  await sleep(300);
  const afterLoad = rssMB();
  log(`[2] after load: ${afterLoad} MB  (+${afterLoad - base} MB, load ${loadMs} ms)`);

  // --- one inference (best-effort: confirm it works + capture TTFT/tps) ---
  try {
    const t0 = Date.now(); let ttft = 0, out = "";
    const run: any = (qvac as any).completion({
      modelId,
      history: [{ role: "user", content: "List 3 danger signs of pneumonia in a child. Be brief." }],
      stream: true,
    });
    if (run?.events) {
      for await (const ev of run.events) {
        const piece = ev?.contentDelta ?? ev?.delta ?? ev?.token ?? "";
        if (piece && !ttft) ttft = Date.now() - t0;
        out += piece;
      }
    }
    const final = run?.final ? await run.final : run;
    const stats = final?.stats ?? {};
    log(`[3] inference OK | TTFT≈${ttft || stats.timeToFirstToken || "?"} ms | tps=${stats.tokensPerSecond ?? "?"} | backend=${stats.backendDevice ?? "?"} | chars=${out.length}`);
    log(`    sample: ${out.slice(0, 160).replace(/\n/g, " ")}`);
  } catch (e: any) {
    log(`[3] inference probe failed (non-fatal for the memory verdict): ${e?.message}`);
    log(`    → completion() shape differs; adjust engine.ts against this error.`);
  }

  // --- unload ---
  try { await (qvac as any).unloadModel({ modelId }); }
  catch (e: any) { try { await (qvac as any).unloadModel(modelId); } catch { log("unloadModel shape differs:", e?.message); } }
  gc(); await sleep(1000); gc(); await sleep(500);
  const afterUnload = rssMB();
  log(`[4] after unload+gc: ${afterUnload} MB  (Δ from baseline +${afterUnload - base} MB)`);

  // --- verdict ---
  const freed = afterLoad - afterUnload;
  const residual = afterUnload - base;
  const pctFreed = afterLoad > base ? Math.round((freed / (afterLoad - base)) * 100) : 0;
  log("\n=== VERDICT ===");
  log(`loaded +${afterLoad - base} MB, freed ${freed} MB (${pctFreed}%), residual +${residual} MB over baseline`);
  if (pctFreed >= 80) log("→ SEQUENTIAL OK: unloadModel frees RAM. Use RESIDENT_MODE=sequential (the plan).");
  else if (residual < 1500) log("→ HYBRID: partial free. Keep MedPsy resident, load/unload STT+TTS around it. RESIDENT_MODE=hybrid.");
  else log("→ FALLBACK: unload does NOT free RAM. RESIDENT_MODE=fallback (single resident + keyword retrieval + OS TTS).");
  try { (qvac as any).close?.(); } catch {}
  await sleep(300);
  process.exit(0);
}
main().catch(e => { console.error("SPIKE ERROR:", e); process.exit(1); });
