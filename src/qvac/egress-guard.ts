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

export interface EgressViolation {
  kind: "dns" | "tcp" | "tls" | "http" | "https" | "fetch";
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

  private record(kind: EgressViolation["kind"], host?: string | null) {
    if (isExternalHost(host)) this.violations.push({ kind, target: String(host) });
  }

  arm(): void {
    if (this.armed) return;
    this.armed = true;
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
  }

  disarm(): void {
    while (this.restores.length) this.restores.pop()!();
    this.armed = false;
  }
}

/** Module-level singleton so the patched closures can reach the active recorder. */
export const guard = new EgressGuard();
