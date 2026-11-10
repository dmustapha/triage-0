import { BACKENDS, MODELS } from "./contract.js";

export type Config = {
  port: number;
  host: "127.0.0.1";
  corsOrigins: string[];
  backend: (typeof BACKENDS)[number];
  model: (typeof MODELS)[number];
  llamaServerUrl: string;
  routeTimeoutMs: number;
  rateLimitPerMin: number;
};

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
}

function oneOf<T extends readonly string[]>(env: NodeJS.ProcessEnv, key: string, allowed: T, fallback: T[number]): T[number] {
  const raw = env[key] ?? fallback;
  if (!allowed.includes(raw)) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
  return raw as T[number];
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const corsOrigins = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (corsOrigins.length === 0) throw new Error("CORS_ORIGINS is required (comma-separated exact origins)");
  for (const o of corsOrigins) {
    if (!/^https?:\/\/[^/*\s]+$/.test(o)) throw new Error(`CORS_ORIGINS entry is not an exact origin: ${o}`);
  }
  return {
    port: int(env, "PORT", 3020),
    host: "127.0.0.1",
    corsOrigins,
    backend: oneOf(env, "BACKEND", BACKENDS, "qvac"),
    model: oneOf(env, "MODEL", MODELS, "medpsy-4b"),
    llamaServerUrl: env.LLAMA_SERVER_URL ?? "http://127.0.0.1:8081",
    routeTimeoutMs: int(env, "ROUTE_TIMEOUT_MS", 20000),
    rateLimitPerMin: int(env, "RATE_LIMIT_PER_MIN", 30),
  };
}
