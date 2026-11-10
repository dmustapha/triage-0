type Field = number | boolean | string;

export const STRING_KEYS_ALLOWED = new Set(["backend", "model", "route", "status", "event", "level"]);
const FORBIDDEN_KEYS = new Set(["text", "body", "prompt", "output", "answer", "case"]);

function check(fields: Record<string, Field>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(k)) throw new Error(`log: key "${k}" is never logged`);
    if (typeof v === "string" && !STRING_KEYS_ALLOWED.has(k)) {
      throw new Error(`log: string field "${k}" is not on the allowlist`);
    }
  }
}

function emit(level: "info" | "warn" | "error", event: string, fields: Record<string, Field> = {}): void {
  check(fields);
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + "\n");
}

export const log = {
  info: (event: string, fields?: Record<string, Field>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, Field>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, Field>) => emit("error", event, fields),
};
