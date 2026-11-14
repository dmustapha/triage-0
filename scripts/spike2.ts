// File: scripts/spike2.ts — corrected probe: worker RSS + event shape
import * as qvac from "@qvac/sdk";
import { execSync } from "node:child_process";
const MODEL = new URL("../.models/medpsy-1.7b-q4_k_m-imat.gguf", import.meta.url).pathname;
const workerRSS = () => {
  try {
    const out = execSync("ps -axo rss,command | grep -i 'qvac-worker\\|bare' | grep -v grep", { encoding: "utf8" });
    const lines = out.trim().split("\n").filter(Boolean);
    const totalKB = lines.reduce((s, l) => s + parseInt(l.trim().split(/\s+/)[0] || "0", 10), 0);
    return { mb: Math.round(totalKB / 1024), procs: lines.length };
  } catch { return { mb: 0, procs: 0 }; }
};
const log = (...a: unknown[]) => console.log(...a);
(async () => {
  log("worker RSS before load:", workerRSS());
  const modelId = await (qvac as any).loadModel({ modelSrc: MODEL, modelType: "llm", modelConfig: { ctx_size: 4096 } });
  await new Promise(r => setTimeout(r, 500));
  log("worker RSS AFTER MedPsy-1.7B load:", workerRSS(), "<-- real model memory");

  // capture the real event shape
  const run: any = (qvac as any).completion({ modelId, history: [{ role: "user", content: "Say: hello" }], stream: true });
  let firstEv: any = null, text = "";
  if (run?.events) for await (const ev of run.events) {
    if (!firstEv) { firstEv = ev; log("FIRST EVENT keys:", Object.keys(ev || {}), "| sample:", JSON.stringify(ev).slice(0, 200)); }
    // try common fields
    text += (ev?.content ?? ev?.text ?? ev?.contentDelta ?? ev?.delta ?? ev?.choices?.[0]?.delta?.content ?? "");
  }
  const final = run?.final ? await run.final : null;
  log("final keys:", final ? Object.keys(final) : "n/a");
  log("captured text len:", text.length, "| text:", text.slice(0, 120));
  if (final?.content || final?.text) log("final.content/text:", (final.content ?? final.text)?.slice?.(0, 120));
  log("worker RSS after inference:", workerRSS());
  await (qvac as any).unloadModel({ modelId });
  (qvac as any).close?.();
  await new Promise(r => setTimeout(r, 1500));
  log("worker RSS after unload+close:", workerRSS(), "<-- should drop toward 0 (worker killed)");
  process.exit(0);
})().catch(e => { console.error("ERR", e); process.exit(1); });
