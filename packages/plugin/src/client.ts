// The client library for out-of-process plugins (spec §9.8): `connect(env)` gives a PluginClient over the daemon's
// plugin socket (CAPCOMD_PLUGIN_SOCKET) with the token the host minted for this start. It uses node:http so a plugin runs
// on Bun or Node alike. The hooks stream reconnects with Last-Event-ID; an answer is retried until the call's deadline;
// a write carries an Idempotency-Key. When the host goes (stdin, the pipe the host holds, closes) the stream ends.
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { PluginError, type PluginErrorCode } from "./errors";
import type { HookName } from "./hooks";
import type { EmitBody, HookAnswer, HookFrame, PluginClient, ProcessEnvironment, SessionOpen, SessionOpened, StorageEntry, StoragePutBody } from "./protocol";

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

const CODE_OF: Record<number, PluginErrorCode> = { 400: "invalid", 401: "forbidden", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "invalid" };
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

export interface ConnectOptions {
  /** End the hooks stream when stdin closes (the host keeps it open while it lives). Default true when stdin is a pipe. */
  endWithStdin?: boolean;
}

/** A PluginClient for this process's environment (§9.2). */
export function connect(env: ProcessEnvironment = process.env as unknown as ProcessEnvironment, o: ConnectOptions = {}): PluginClient & { session: string; gone: AbortSignal } {
  const socket = env.CAPCOMD_PLUGIN_SOCKET, token = env.CAPCOMD_PLUGIN_TOKEN, name = env.CAPCOMD_PLUGIN_NAME;
  if (!socket || !token || !name) throw new PluginError("invalid", "not started by capcomd: CAPCOMD_PLUGIN_SOCKET, CAPCOMD_PLUGIN_TOKEN and CAPCOMD_PLUGIN_NAME are required (§9.2)");
  const base = `/v1/plugins/${encodeURIComponent(name)}`;
  const gone = new AbortController();
  if (o.endWithStdin ?? !process.stdin.isTTY) {
    process.stdin.on("end", () => gone.abort());
    process.stdin.on("close", () => gone.abort());
    process.stdin.resume();
  }
  const deadlines = new Map<string, number>();

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath: socket, path, method, headers: { host: "localhost", authorization: `Bearer ${token}`, ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers } }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { s += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: s }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
  const ok = async <T>(p: Promise<Res>): Promise<T> => {
    const r = await p;
    if (r.status >= 200 && r.status < 300) return (r.body ? JSON.parse(r.body) : undefined) as T;
    let message = r.body;
    try { message = (JSON.parse(r.body) as { message?: string }).message ?? r.body; } catch { /* not JSON */ }
    throw new PluginError(CODE_OF[r.status] ?? "unavailable", `${r.status}: ${message}`, undefined, r.status >= 500);
  };
  const key = () => `plg-${randomBytes(12).toString("hex")}`;

  async function* hooks(signal: AbortSignal): AsyncIterable<HookFrame> {
    const stop = AbortSignal.any([signal, gone.signal]);
    let last: number | null = null;
    for (let attempt = 0; !stop.aborted; attempt++) {
      const frames: HookFrame[] = [];
      let wake: (() => void) | null = null;
      let ended = false, refused = null as PluginError | null;
      const req = request({ socketPath: socket, path: `${base}/hooks?session=${encodeURIComponent(env.CAPCOMD_PLUGIN_SESSION)}`, method: "GET", headers: { host: "localhost", authorization: `Bearer ${token}`, accept: "text/event-stream", ...(last !== null ? { "last-event-id": String(last) } : {}) } }, (res) => {
        if (res.statusCode !== 200) {
          let s = "";
          res.on("data", (d) => { s += d; });
          res.on("end", () => { refused = new PluginError(CODE_OF[res.statusCode ?? 0] ?? "unavailable", `${res.statusCode}: ${s}`); ended = true; wake?.(); });
          return;
        }
        attempt = 0;
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          buf += d;
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try { frames.push(JSON.parse(data) as HookFrame); } catch { /* not a frame */ }
          }
          wake?.();
        });
        res.on("end", () => { ended = true; wake?.(); });
        res.on("error", () => { ended = true; wake?.(); });
      });
      req.on("error", () => { ended = true; wake?.(); });
      req.end();
      const abort = () => { req.destroy(); ended = true; wake?.(); };
      stop.addEventListener("abort", abort, { once: true });
      try {
        for (;;) {
          while (frames.length) {
            const f = frames.shift()!;
            last = f.seq;
            if (f.frame === "hook.call") deadlines.set(f.call.callId, Date.parse(f.call.deadline));
            yield f;
            if (f.frame === "session.closing") return;
          }
          if (ended) break;
          await new Promise<void>((r) => { wake = r; });
          wake = null;
        }
      } finally { stop.removeEventListener("abort", abort); req.destroy(); }
      if (refused) throw refused;
      await sleep(Math.min(5000, 250 * 2 ** attempt), stop);
    }
  }

  return {
    session: env.CAPCOMD_PLUGIN_SESSION,
    gone: gone.signal,
    open: (body: SessionOpen) => ok<SessionOpened>(call("POST", `${base}/sessions`, body)),
    hooks,
    async answer<N extends HookName>(callId: string, answer: HookAnswer<N>): Promise<void> {
      const until = deadlines.get(callId) ?? Date.now() + 5000;
      for (let i = 0; ; i++) {
        try {
          await ok(call("POST", `${base}/hooks/${encodeURIComponent(callId)}`, answer));
          deadlines.delete(callId);
          return;
        } catch (e) {
          // A refusal is final (the host already judged the call); a lost connection is tried again until the deadline.
          if (e instanceof PluginError && !e.retryable) throw e;
          if (Date.now() + 100 > until) throw e;
          await sleep(Math.min(1000, 50 * 2 ** i));
        }
      }
    },
    emit: (body: EmitBody) => ok<{ seq: number }>(call("POST", `${base}/events`, body, { "idempotency-key": key() })),
    storage: {
      async get(k: string, run?: string) {
        try { return await ok<StorageEntry>(call("GET", `${base}/storage/${k}${run ? `?run=${encodeURIComponent(run)}` : ""}`)); } catch (e) {
          if (e instanceof PluginError && e.code === "not_found") return null;
          throw e;
        }
      },
      put: (k: string, body: StoragePutBody, run?: string) => ok<StorageEntry>(call("PUT", `${base}/storage/${k}${run ? `?run=${encodeURIComponent(run)}` : ""}`, body)),
      delete: async (k: string, run?: string) => { await ok(call("DELETE", `${base}/storage/${k}${run ? `?run=${encodeURIComponent(run)}` : ""}`)); },
      list: async (prefix: string, run?: string) => (await ok<{ entries: StorageEntry[] }>(call("GET", `${base}/storage?prefix=${encodeURIComponent(prefix)}${run ? `&run=${encodeURIComponent(run)}` : ""}`))).entries,
    },
    async fetch(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
      const r = await call(init.method ?? "GET", path, init.body, init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {});
      return new Response(r.body || null, { status: r.status });
    },
  };
}
