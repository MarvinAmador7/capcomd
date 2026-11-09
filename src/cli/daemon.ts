// The CLI's client of the running daemon (docs/harness-architecture.md §6.3): a harness.v1 call for what only the daemon
// can do, such as turning one of its plugins on or off (`capcomd plugins enable|disable`, plugin API §5.4). The running
// daemon is the one whose plugin listing is in state/plugins.json (its pid alive), at the harness socket it recorded
// there (a daemon from before it did: the socket `capcomd serve` would bind). The CLI holds no API token: each call
// makes one with the scope it needs and deletes it once answered (src/api/clients.ts `oneCallClient`).
import { randomUUID } from "node:crypto";
import type { ClientScope } from "../api/clients";

/** What a call came to: no daemon runs (`none`), it answered (`status`, `body`), or it runs and couldn't be asked. */
export type DaemonCall =
  | { kind: "none" }
  | { kind: "answered"; pid: number; status: number; body: Record<string, unknown> }
  | { kind: "unreachable"; pid: number; reason: string };

/** `method path` on the running daemon, with a token of `scope` for this call only. */
export async function callDaemon(method: "GET" | "POST", path: string, o: { scope: ClientScope; body?: unknown; timeoutMs?: number }): Promise<DaemonCall> {
  const { readSnapshot } = await import("../plugins/host");
  const snap = readSnapshot();
  if (!snap) return { kind: "none" };
  const socket = typeof snap.socket === "string" && snap.socket ? snap.socket : await (await import("./commands/serve")).harnessSocket();
  const C = await import("../api/clients");
  let made: ReturnType<typeof C.oneCallClient>;
  try { made = C.oneCallClient("capcomd CLI (one call)", [o.scope]); } catch (e) { return { kind: "unreachable", pid: snap.pid, reason: `no token for the call: ${(e as Error).message}` }; }
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
    return { kind: "unreachable", pid: snap.pid, reason: `${socket} didn't answer (${code ?? (e as Error).name ?? "error"})` };
  } finally {
    try { made.remove(); } catch { /* its token ends with this process: the record left behind matches nothing anyone holds */ }
  }
}
