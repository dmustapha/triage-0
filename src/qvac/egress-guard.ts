// File: src/qvac/egress-guard.ts
// Offline-egress guard (PLAN E2 — the headline thesis proof). Monkeypatches the Node networking
// chokepoints in THIS process to record any attempt to reach an EXTERNAL host (anything that is not
// loopback or a unix-domain socket). The patient's data never leaves the device: arm() the guard,
// run a full triage after the model cache is warm, disarm() — `violations` must be empty.
//
// Scope note: the @qvac/sdk inference runs in a separate bare-worker process over a UNIX socket (not
// network egress). After the model cache is warm the worker performs only local Metal-GPU inference;
// this guard proves the application + SDK-client process make zero outbound connections during a triage.
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";

export interface EgressViolation {
  kind: "dns" | "tcp" | "tls" | "http" | "https" | "fetch" | "http2" | "udp";
  target: string;
}

/** External = not loopback and not a unix-socket path. Loopback + IPC are allowed. */
export function isExternalHost(host?: string | null): boolean {
  if (!host) return false; // unix socket / no host
  const h = String(host).toLowerCase();
  if (h.startsWith("/") || h.includes(".sock")) return false; // unix socket path
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::") return false;
  if (h.startsWith("127.")) return false;
  return true;
}

export class EgressGuard {
  readonly violations: EgressViolation[] = [];
  private restores: Array<() => void> = [];
  private armed = false;
  private strict = false;

  /** Is the guard currently intercepting network calls? (surfaced on /health). */
  get isArmed(): boolean { return this.armed; }
  /** Does a violation throw (block the connection) rather than only being recorded? */
  get isStrict(): boolean { return this.strict; }

  private record(kind: EgressViolation["kind"], host?: string | null) {
    if (!isExternalHost(host)) return;
    this.violations.push({ kind, target: String(host) });
    // Strict mode (H-6): BLOCK the connection, not just record it. Armed in the serving process only AFTER
    // all model prewarm, so the one disclosed egress (first-run weight download) is already done — from
    // here any external connection is a real violation and must be stopped. This converts the "case never
    // leaves the device" thesis from tested → enforced. Throwing aborts the offending connect/request.
    if (this.strict) {
      throw new Error(
        `[egress-guard] BLOCKED external ${kind} connection to ${host} — the patient's case must never leave the device`,
      );
    }
  }

  arm(strict = false): void {
    if (this.armed) return;
    this.armed = true;
    this.strict = strict;
    this.violations.length = 0;

    // net.Socket.prototype.connect — TCP. connect(options|port|path[, host][, cb]).
    const origConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      const a = args[0];
      let host: string | undefined;
      if (a && typeof a === "object") {
        const o = a as { host?: string; path?: string };
        if (!o.path) host = o.host;
      } else if (typeof a === "number") {
        host = typeof args[1] === "string" ? (args[1] as string) : undefined;
      } // string arg => unix socket path => ignored
      guard.record("tcp", host);
      return (origConnect as (...x: unknown[]) => net.Socket).apply(this, args);
    } as typeof net.Socket.prototype.connect;
    this.restores.push(() => { net.Socket.prototype.connect = origConnect; });

    // tls.connect — TLS. connect(options|port[, host][, options][, cb]).
    const origTls = tls.connect;
    (tls as { connect: unknown }).connect = (...args: unknown[]) => {
      const a = args[0];
      let host: string | undefined;
      if (a && typeof a === "object") host = (a as { host?: string; servername?: string }).host ?? (a as { servername?: string }).servername;
      else if (typeof a === "number") host = typeof args[1] === "string" ? (args[1] as string) : undefined;
      guard.record("tls", host);
      return (origTls as (...x: unknown[]) => unknown).apply(tls, args);
    };
    this.restores.push(() => { (tls as { connect: unknown }).connect = origTls; });

    // dns.lookup — the chokepoint for almost all hostname egress.
    const origLookup = dns.lookup;
    (dns as { lookup: unknown }).lookup = (hostname: string, ...rest: unknown[]) => {
      guard.record("dns", hostname);
      return (origLookup as (...x: unknown[]) => unknown).call(dns, hostname, ...rest);
    };
    this.restores.push(() => { (dns as { lookup: unknown }).lookup = origLookup; });

    const origPLookup = dns.promises.lookup;
    (dns.promises as { lookup: unknown }).lookup = (hostname: string, ...rest: unknown[]) => {
      guard.record("dns", hostname);
      return (origPLookup as (...x: unknown[]) => unknown).call(dns.promises, hostname, ...rest);
    };
    this.restores.push(() => { (dns.promises as { lookup: unknown }).lookup = origPLookup; });

    // http(s).request — high-level.
    for (const [mod, kind] of [[http, "http"], [https, "https"]] as const) {
      const orig = mod.request;
      (mod as { request: unknown }).request = (...args: unknown[]) => {
        const a = args[0];
        let host: string | undefined;
        if (typeof a === "string") { try { host = new URL(a).hostname; } catch { /* ignore */ } }
        else if (a instanceof URL) host = a.hostname;
        else if (a && typeof a === "object") host = (a as { host?: string; hostname?: string }).hostname ?? (a as { host?: string }).host;
        guard.record(kind, host);
        return (orig as (...x: unknown[]) => unknown).apply(mod, args);
      };
      this.restores.push(() => { (mod as { request: unknown }).request = orig; });
    }

    // global fetch (undici).
    const origFetch = globalThis.fetch;
    if (origFetch) {
      globalThis.fetch = ((input: unknown, init?: unknown) => {
        let host: string | undefined;
        try {
          const u = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL((input as { url: string }).url);
          host = u.hostname;
        } catch { /* ignore */ }
        guard.record("fetch", host);
        return (origFetch as (...x: unknown[]) => Promise<Response>)(input, init);
      }) as typeof fetch;
      this.restores.push(() => { globalThis.fetch = origFetch; });
    }

    // http2.connect — HTTP/2 (e.g. gRPC-web). connect(authority[, options][, listener]).
    const origH2 = http2.connect;
    (http2 as { connect: unknown }).connect = (...args: unknown[]) => {
      const a = args[0];
      let host: string | undefined;
      try { const u = typeof a === "string" ? new URL(a) : a instanceof URL ? a : undefined; host = u?.hostname; } catch { /* ignore */ }
      guard.record("http2", host);
      return (origH2 as (...x: unknown[]) => unknown).apply(http2, args);
    };
    this.restores.push(() => { (http2 as { connect: unknown }).connect = origH2; });

    // dns.resolve* — the resolver family (distinct from dns.lookup), incl. the promises variants.
    for (const name of ["resolve", "resolve4", "resolve6", "resolveAny"] as const) {
      const orig = (dns as Record<string, unknown>)[name];
      if (typeof orig === "function") {
        (dns as Record<string, unknown>)[name] = (hostname: string, ...rest: unknown[]) => {
          guard.record("dns", hostname);
          return (orig as (...x: unknown[]) => unknown).call(dns, hostname, ...rest);
        };
        this.restores.push(() => { (dns as Record<string, unknown>)[name] = orig; });
      }
      const origP = (dns.promises as Record<string, unknown>)[name];
      if (typeof origP === "function") {
        (dns.promises as Record<string, unknown>)[name] = (hostname: string, ...rest: unknown[]) => {
          guard.record("dns", hostname);
          return (origP as (...x: unknown[]) => unknown).call(dns.promises, hostname, ...rest);
        };
        this.restores.push(() => { (dns.promises as Record<string, unknown>)[name] = origP; });
      }
    }

    // dgram (UDP) — patch each created socket's send; the address arg (the string after the numeric port)
    // is the egress target. Current deps use no UDP; this hardens the proof against dependency drift.
    const origDgram = dgram.createSocket;
    (dgram as { createSocket: unknown }).createSocket = (...args: unknown[]) => {
      const sock = (origDgram as (...x: unknown[]) => dgram.Socket).apply(dgram, args);
      const origSend = sock.send.bind(sock);
      (sock as { send: unknown }).send = (...sargs: unknown[]) => {
        const portIdx = sargs.findIndex((x) => typeof x === "number");
        const addr = portIdx >= 0 && typeof sargs[portIdx + 1] === "string" ? (sargs[portIdx + 1] as string) : undefined;
        guard.record("udp", addr);
        return (origSend as (...x: unknown[]) => unknown)(...sargs);
      };
      return sock;
    };
    this.restores.push(() => { (dgram as { createSocket: unknown }).createSocket = origDgram; });
  }

  disarm(): void {
    while (this.restores.length) this.restores.pop()!();
    this.armed = false;
    this.strict = false;
  }
}

/** Module-level singleton so the patched closures can reach the active recorder. */
export const guard = new EgressGuard();
