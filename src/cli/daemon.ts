// The CLI's client of the running daemon (docs/harness-architecture.md §6.3): a harness.v1 call for what only the daemon
// can do, such as turning one of its plugins on or off (`capcomd plugins enable|disable`, plugin API §5.4). The running
// daemon is the one whose plugin listing is in state/plugins.json (its pid alive), at the harness socket it recorded
// there (a daemon from before it did: the socket `capcomd serve` would bind). The CLI holds no API token: each call
// makes one with the scope it needs and deletes it once answered (src/api/clients.ts `oneCallClient`).
// A front door's verify, merge and approval of a merge go to the daemon that hosts its engine (`daemonOp`, plugin API
// §6.1), so every plugin's gate judges them; src/primitives/front-door.ts decides what runs where.
import { randomUUID } from "node:crypto";
import type { ClientScope } from "../api/clients";
import type { PluginsSnapshot } from "../plugins/snapshot";

/** What a call came to: no daemon runs (`none`), it answered (`status`, `body`), or it runs and couldn't be asked. */
export type DaemonCall =
  | { kind: "none" }
  | { kind: "answered"; pid: number; status: number; body: Record<string, unknown> }
  | { kind: "unreachable"; pid: number; reason: string; notSent?: true };

/** `method path` on the running daemon, with a token of `scope` for this call only. `snapshot`: that daemon's listing
 *  (default: the running daemon's, whichever engine it hosts); `frontDoor`: the call is a front door's operation. */
export async function callDaemon(method: "GET" | "POST", path: string, o: { scope: ClientScope; body?: unknown; timeoutMs?: number; snapshot?: PluginsSnapshot; frontDoor?: boolean }): Promise<DaemonCall> {
  const snap = o.snapshot ?? (await import("../plugins/snapshot")).readSnapshot();
  if (!snap) return { kind: "none" };
  const socket = typeof snap.socket === "string" && snap.socket ? snap.socket : await (await import("./commands/serve")).harnessSocket();
  const C = await import("../api/clients");
  let made: ReturnType<typeof C.oneCallClient>;
  try { made = C.oneCallClient(o.frontDoor ? "capcomd front door (one call)" : "capcomd CLI (one call)", [o.scope], undefined, { frontDoor: o.frontDoor }); } catch (e) { return { kind: "unreachable", pid: snap.pid, reason: `no token for the call: ${(e as Error).message}` }; }
  try {
    const r = await fetch(`http://localhost${path}`, {
      method, unix: socket, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      headers: { authorization: `Bearer ${made.token}`, "idempotency-key": `cli-${randomUUID()}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    } as RequestInit);
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: "answered", pid: snap.pid, status: r.status, body };
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { kind: "unreachable", pid: snap.pid, reason: `${socket} didn't answer (${code ?? (e as Error).name ?? "error"})`, ...(NOT_SENT.test(code ?? "") ? { notSent: true as const } : {}) };
  } finally {
    try { made.remove(); } catch { /* its token ends with this process: the record left behind matches nothing anyone holds */ }
  }
}

/** A socket nobody serves (refused, gone): the request never reached a daemon. */
const NOT_SENT = /^(ECONNREFUSED|ENOENT|ConnectionRefused|FailedToOpenSocket)$/;

/** Whether two engine endpoints are one engine: the same port on this machine's loopback, else the same origin. */
export function sameEngine(a: string, b: string): boolean {
  const u = (s: string) => { try { return new URL(s); } catch { return null; } };
  const x = u(a), y = u(b);
  if (!x || !y) return false;
  const loop = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  const port = (v: URL) => v.port || (v.protocol === "https:" ? "443" : "80");
  if (loop(x.hostname) && loop(y.hostname)) return port(x) === port(y);
  return x.origin === y.origin;
}

/** The running daemon that hosts the engine this process talks to (`CAPCOMD_ENDPOINT`), or null: none runs, or the one
 *  that runs hosts another engine or doesn't say which (a daemon from before its listing named it). */
export async function engineDaemon(): Promise<PluginsSnapshot | null> {
  const snap = (await import("../plugins/snapshot")).readSnapshot();
  if (!snap || typeof snap.endpoint !== "string") return null;
  const { endpoint } = await import("../core/relay");
  return sameEngine(snap.endpoint, endpoint()) ? snap : null;
}

/** What a front door's operation came to in the daemon: no daemon could take it (`none`: the caller may run it itself,
 *  nothing was sent), it ended (`done`, its record) or it still runs there (`running`). A refusal throws its RelayError. */
export type DaemonOp = { kind: "none"; reason: string } | { kind: "done"; id: string; value: Record<string, unknown> } | { kind: "running"; id: string };

/**
 * A front door's verify, merge or approval (capability ops.front_door) on `daemon`: `path`, with a front-door token of
 * `scope` for this one call. The body's `waitMs` bounds the answer. A daemon that doesn't serve the route (one from
 * before it) is `none`, as is a socket nobody serves; anything else that goes wrong once the request may have reached it
 * throws (retryable): the operation may be running there, and asking again with its id picks it up.
 */
export async function daemonOp(daemon: PluginsSnapshot, path: string, body: Record<string, unknown> & { waitMs: number }, scope: ClientScope): Promise<DaemonOp> {
  const { RelayError } = await import("../core/errors");
  const call = () => callDaemon("POST", path, { scope, body, snapshot: daemon, frontDoor: true, timeoutMs: body.waitMs + 30_000 });
  let r = await call();
  // Another process rewrote the clients file between this one's write and the daemon's read (the file has no lock):
  // the token is new each time, so the next one is.
  if (r.kind === "answered" && r.status === 401) r = await call();
  if (r.kind === "none") return { kind: "none", reason: "no daemon runs" };
  if (r.kind === "unreachable") {
    if (r.notSent) return { kind: "none", reason: `the daemon (pid ${r.pid}) doesn't answer: ${r.reason}` };
    throw new RelayError("run_failed", `the daemon (pid ${r.pid}) didn't answer: ${r.reason}`, "Run the same command again (with the id it printed, if any): the operation may be running in the daemon, and asking again picks it up.", { code: "daemon_unreachable", retryable: true });
  }
  const b = r.body as { done?: unknown; id?: unknown; op?: unknown; code?: unknown; message?: unknown; relay?: { code?: string; message?: string; hint?: string; reason?: string; retryable?: boolean } };
  if (r.status === 200 && b.done === true && typeof b.id === "string" && b.op && typeof b.op === "object") return { kind: "done", id: b.id, value: b.op as Record<string, unknown> };
  if (r.status === 202 && typeof b.id === "string") return { kind: "running", id: b.id };
  const rel = b.relay;
  if (rel && typeof rel.message === "string" && ["usage", "config", "not_found", "conflict", "run_failed", "engine_unreachable"].includes(rel.code ?? ""))
    throw new RelayError(rel.code as import("../core/errors").ErrorCode, rel.message, rel.hint ?? "", { ...(rel.reason ? { code: rel.reason } : {}), ...(rel.retryable ? { retryable: true } : {}) });
  // A daemon from before these routes: no such route (404), or, for a decision, the scope it asked of every other POST
  // (403). Nothing ran there. (The operation's own refusals carry `relay`.)
  if (rel === undefined && (r.status === 404 || (r.status === 403 && /^token lacks the steer scope/.test(String(b.message ?? "")))))
    return { kind: "none", reason: `the daemon (pid ${r.pid}) doesn't run front doors' operations (it predates them; restart it)` };
  throw new RelayError("run_failed", `the daemon (pid ${r.pid}) answered ${r.status}${typeof b.message === "string" ? `: ${b.message}` : ""}`, "Retry; if it keeps failing, see the daemon's log.", { code: "daemon_refused" });
}
