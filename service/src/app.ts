import express, { type Express, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { RouteRequestSchema, type RouteRequest, type RouteResponse } from "./contract.js";
import { log } from "./log.js";

export type AppDeps = {
  route: (req: RouteRequest) => Promise<RouteResponse>;
  health: () => { ok: boolean; backend: string; model: string };
  corsOrigins: string[];
  rateLimitPerMin: number;
};

export const MSG = {
  empty: "Tell us what is happening.",
  tooLong: "That is too long. A sentence or two is enough.",
  tooMany: "Too many requests from this connection. If this is an emergency, call for an ambulance now.",
  serverError: "Something went wrong on our side. Call for an ambulance if you have not already.",
} as const;

function cors(origins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}

function validationMessage(issues: { path: PropertyKey[]; code: string }[]): string {
  const textIssue = issues.find((i) => i.path[0] === "text");
  if (textIssue?.code === "too_big") return MSG.tooLong;
  return MSG.empty;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(cors(deps.corsOrigins));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    const { ok, backend, model } = deps.health();
    res.json({ ok, backend, model });
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: deps.rateLimitPerMin,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: MSG.tooMany },
  });

  app.post("/route", limiter, async (req, res, next) => {
    const parsed = RouteRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: validationMessage(parsed.error.issues) });
    try {
      res.json(await deps.route(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: MSG.tooLong });
    if (err.type === "entity.parse.failed" || err.status === 400) return res.status(400).json({ error: MSG.empty });
    log.error("request_failed", err, { route: "/route", status: 500 });
    res.status(500).json({ error: MSG.serverError });
  });
  return app;
}
