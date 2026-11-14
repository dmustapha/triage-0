import type { CompleteArgs, CompleteResult, RouteBackend } from "./types.js";

export type FakeStep = string | Error | "hang";

/** Scripted backend for tests: each call consumes the next step. "hang" waits until the signal aborts. */
export function createFakeBackend(script: FakeStep[]): RouteBackend & { calls: number } {
  const steps = [...script];
  const b = {
    name: "qvac" as const,
    model: "medpsy-1.7b" as const,
    calls: 0,
    async start() {},
    async stop() {},
    async complete(a: CompleteArgs): Promise<CompleteResult> {
      b.calls++;
      const step = steps.shift();
      if (step === undefined) throw new Error("fake backend: script exhausted");
      if (step instanceof Error) throw step;
      if (step === "hang") {
        await new Promise<void>((_, rej) => a.signal.addEventListener("abort", () => rej(a.signal.reason), { once: true }));
      }
      return { text: step as string, ttftMs: 5, totalMs: 10, tokensPerS: 100 };
    },
  };
  return b;
}
