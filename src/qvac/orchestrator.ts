// File: src/qvac/orchestrator.ts
// Process-wide model-lifecycle manager. RECONCILED from ARCHITECTURE §3b: the Phase-0 memory spike
// proved unloadModel reclaims fully, so the default RESIDENT_MODE is "resident" — load each role once,
// keep it (MedPsy ~1GB + GTE ~0.6GB + whisper-tiny ~0.04GB + supertonic ~0.25GB ≈ 1.9GB, well under
// 8GB). Other modes unload transient STT/TTS around use. The store is single-writer, so exactly ONE
// orchestrator (this singleton) owns all model handles for the process.
//
// Phase 2's triage takes caller-loaded model ids (TriageContext), so the orchestrator exposes
// getMedpsy()/getEmbeddings() that the server feeds into runTriage — the orchestrator owns lifecycle,
// triage stays pure and testable.
import { config, registry, medpsySpec, type ModelSpec } from "../config.js";
import { loadModelTimed, unloadModelTimed } from "./engine.js";
import { close } from "./sdk.js";

interface Resident {
  modelId: string;
  spec: ModelSpec;
}

/** Whether a role stays loaded after use, per RESIDENT_MODE. */
function keepsResident(role: string): boolean {
  switch (config.residentMode) {
    case "resident":
      return true; // keep everything (proven safe on this M1)
    case "hybrid":
    case "fallback":
      return role === "medpsy" || role === "embeddings"; // keep the big reasoners; cycle STT/TTS
    case "sequential":
      return false; // one role at a time
    default:
      return true;
  }
}

class Orchestrator {
  private residents = new Map<string, Resident>(); // keyed by role
  private loading = new Map<string, Promise<string>>(); // in-flight loads, keyed by role

  /**
   * Load a role if not already resident; returns the modelId. Concurrency-safe: two simultaneous
   * first-hits on the same role share ONE load promise instead of both calling loadModelTimed and
   * double-loading the model (a real OOM risk on 8GB — MedPsy alone is ~1GB). The in-flight promise is
   * cached for the duration of the load and cleared on settle so a later miss can reload after release.
   */
  async ensure(spec: ModelSpec, phase: string): Promise<string> {
    const existing = this.residents.get(spec.role);
    if (existing) return existing.modelId;
    const inFlight = this.loading.get(spec.role);
    if (inFlight) return inFlight;
    const load = (async () => {
      const { modelId } = await loadModelTimed(spec, phase);
      this.residents.set(spec.role, { modelId, spec });
      return modelId;
    })();
    this.loading.set(spec.role, load);
    try {
      return await load;
    } finally {
      this.loading.delete(spec.role);
    }
  }

  /** Unload a role unless the current RESIDENT_MODE keeps it. */
  async release(role: string, phase: string): Promise<void> {
    if (keepsResident(role)) return;
    const r = this.residents.get(role);
    if (!r) return;
    await unloadModelTimed(r.modelId, role, phase);
    this.residents.delete(role);
  }

  // ── reasoning model ids for triage's TriageContext (the server passes these to runTriage) ──
  async getMedpsy(phase = "triage"): Promise<string> {
    return this.ensure(medpsySpec(), phase);
  }
  async getEmbeddings(phase = "triage"): Promise<string> {
    return this.ensure(registry.embeddings, phase);
  }

  // ── transient voice stages: load (or reuse), run, release per mode ──
  async withStt<T>(phase: string, fn: (modelId: string) => Promise<T>): Promise<T> {
    const id = await this.ensure(registry.stt, phase);
    try {
      return await fn(id);
    } finally {
      await this.release("stt", phase);
    }
  }

  async withTts<T>(phase: string, fn: (modelId: string) => Promise<T>): Promise<T> {
    const id = await this.ensure(registry.tts, phase);
    try {
      return await fn(id);
    } finally {
      await this.release("tts", phase);
    }
  }

  /** Embeddings-only stage (ingest, which has no MedPsy loaded). */
  async withEmbeddings<T>(phase: string, fn: (embedId: string) => Promise<T>): Promise<T> {
    const id = await this.ensure(registry.embeddings, phase);
    try {
      return await fn(id);
    } finally {
      await this.release("embeddings", phase);
    }
  }

  residentRoles(): string[] {
    return [...this.residents.keys()];
  }

  /** Unload everything and release the SDK worker. Call once at process shutdown. */
  async shutdown(): Promise<void> {
    for (const [role, r] of this.residents) {
      try {
        await unloadModelTimed(r.modelId, role, "shutdown");
      } catch {
        /* best-effort */
      }
    }
    this.residents.clear();
    close();
  }
}

/** Singleton — one orchestrator per process so RAM and the single-writer store are bounded. */
export const orchestrator = new Orchestrator();
