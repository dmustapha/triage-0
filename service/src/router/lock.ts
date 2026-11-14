export class QueueFullError extends Error {
  constructor() { super("inference queue full"); this.name = "QueueFullError"; }
}
export class InferenceTimeoutError extends Error {
  constructor() { super("inference timed out"); this.name = "InferenceTimeoutError"; }
}

export interface InferenceLock {
  run<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T>;
  readonly waiting: number;
}

export const MAX_QUEUE_DEPTH = 4;

/** Single-flight: one inference at a time, at most MAX_QUEUE_DEPTH callers waiting. */
export function createInferenceLock(maxDepth = MAX_QUEUE_DEPTH): InferenceLock {
  let busy = false;
  const queue: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  function acquire(signal: AbortSignal): Promise<void> {
    if (!busy) { busy = true; return Promise.resolve(); }
    if (queue.length >= maxDepth) return Promise.reject(new QueueFullError());
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      queue.push(entry);
      signal.addEventListener("abort", () => {
        const i = queue.indexOf(entry);
        if (i >= 0) { queue.splice(i, 1); reject(signal.reason); }
      }, { once: true });
    });
  }
  function release(): void {
    const next = queue.shift();
    if (next) next.resolve(); else busy = false;
  }

  /** The deadline covers queue wait and inference together: a person never waits longer than timeoutMs. */
  async function run<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new InferenceTimeoutError()), timeoutMs);
    let held = false;
    try {
      await acquire(ac.signal);
      held = true;
      return await Promise.race([
        fn(ac.signal),
        new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(ac.signal.reason), { once: true })),
      ]);
    } finally {
      clearTimeout(timer);
      if (held) release();
    }
  }
  return { run, get waiting() { return queue.length; } };
}
