// ADR-017 transport: a request spool the in-VM CLI writes and the orchestrator drains.
//   <dir>/token        capability token (written + refreshed by the orchestrator)
//   <dir>/req/<id>.json   new requests (atomic rename by the client)
//   <dir>/work/<id>.json  taken by the orchestrator, not yet answered (survives a host crash)
//   <dir>/res/<id>.json   answers (atomic rename)
// LocalSpool is a host directory (scripted fake agents, tests). VmSpool does the same over
// boxd exec/upload: no inbound route and no egress from the VM.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { SandboxProvider, VmId } from "../providers/sandbox";
import type { RpcRequest, RpcResponse } from "./rpc";

export interface Spool {
  /** Take pending requests (new ones, plus any taken earlier but never answered). */
  take(): Promise<Array<{ file: string; req: RpcRequest | null; raw: string }>>;
  answer(items: Array<{ file: string; res: RpcResponse }>): Promise<void>;
  writeToken(token: string): Promise<void>;
  /** Extra per-tick log lines (VM: new agent.jsonl lines). */
  logs?(): Promise<string[]>;
}

const parseReq = (raw: string): RpcRequest | null => { try { return JSON.parse(raw); } catch { return null; } };

export class LocalSpool implements Spool {
  constructor(readonly dir: string) { for (const d of ["req", "work", "res"]) mkdirSync(join(dir, d), { recursive: true }); }
  async take() {
    for (const f of readdirSync(join(this.dir, "req"))) if (f.endsWith(".json")) { try { renameSync(join(this.dir, "req", f), join(this.dir, "work", f)); } catch {} }
    return readdirSync(join(this.dir, "work")).filter((f) => f.endsWith(".json")).map((f) => { const raw = readFileSync(join(this.dir, "work", f), "utf8"); return { file: f, raw, req: parseReq(raw) }; });
  }
  async answer(items: Array<{ file: string; res: RpcResponse }>) {
    for (const { file, res } of items) {
      const tmp = join(this.dir, "res", `.${file}.tmp`);
      writeFileSync(tmp, JSON.stringify(res));
      renameSync(tmp, join(this.dir, "res", file));
      rmSync(join(this.dir, "work", file), { force: true });
    }
  }
  async writeToken(token: string) { const t = join(this.dir, ".token.tmp"); writeFileSync(t, token, { mode: 0o600 }); renameSync(t, join(this.dir, "token")); }
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const MARK = "\n@@CAPCOMD_RPC ";

export class VmSpool implements Spool {
  private consumed = 0;
  constructor(readonly provider: SandboxProvider, readonly vmId: VmId, readonly dir: string, readonly jsonl?: string) {}
  async take() {
    const d = sq(this.dir);
    const script = `mkdir -p ${d}/req ${d}/work ${d}/res; cd ${d} || exit 0; for f in req/*.json; do [ -f "$f" ] && mv "$f" work/; done; for f in work/*.json; do [ -f "$f" ] && printf '${MARK.replace("\n", "\\n")}%s\\n' "$(basename "$f")" && cat "$f"; done; true`;
    const r = await this.provider.exec(this.vmId, ["sh", "-c", script], { timeoutMs: 20_000 });
    return r.stdout.split(MARK).slice(1).map((chunk) => { const nl = chunk.indexOf("\n"); const file = chunk.slice(0, nl).trim(); const raw = chunk.slice(nl + 1); return { file, raw, req: parseReq(raw) }; }).filter((x) => x.file);
  }
  async answer(items: Array<{ file: string; res: RpcResponse }>) {
    if (!items.length) return;
    for (const { file, res } of items) await this.provider.upload(this.vmId, `${this.dir}/res/.${file}.tmp`, new TextEncoder().encode(JSON.stringify(res)));
    const mv = items.map(({ file }) => `mv -f ${sq(`${this.dir}/res/.${file}.tmp`)} ${sq(`${this.dir}/res/${file}`)} && rm -f ${sq(`${this.dir}/work/${file}`)}`).join("; ");
    await this.provider.exec(this.vmId, ["sh", "-c", mv], { timeoutMs: 20_000 });
  }
  async writeToken(token: string) {
    await this.provider.exec(this.vmId, ["sh", "-c", `mkdir -p ${sq(this.dir)} && chmod 700 ${sq(this.dir)}`], { timeoutMs: 20_000 });
    await this.provider.upload(this.vmId, `${this.dir}/.token.tmp`, new TextEncoder().encode(token));
    await this.provider.exec(this.vmId, ["sh", "-c", `chmod 600 ${sq(`${this.dir}/.token.tmp`)} && mv -f ${sq(`${this.dir}/.token.tmp`)} ${sq(`${this.dir}/token`)}`], { timeoutMs: 20_000 });
  }
  async logs() {
    if (!this.jsonl) return [];
    const r = await this.provider.exec(this.vmId, ["sh", "-c", `tail -n +${this.consumed + 1} ${sq(this.jsonl)} 2>/dev/null | head -n 500`], { timeoutMs: 20_000 });
    const lines = r.stdout.split("\n").filter((l, i, a) => l.length || i < a.length - 1);
    if (lines.length && !r.stdout.endsWith("\n")) lines.pop(); // partial last line: next tick
    this.consumed += lines.length;
    return lines.filter(Boolean);
  }
}

export interface PumpOpts {
  spool: Spool;
  handle: (req: RpcRequest) => Promise<RpcResponse>;
  intervalMs?: number;
  /** Called with new log lines (and each handled op as a log line). */
  onLog?: (lines: string[]) => void;
  /** Mint a fresh token; called at start and every refreshMs. */
  mintToken?: () => string;
  refreshMs?: number;
}

/** Drain the spool until stopped. Requests in one tick are handled concurrently. */
export function startPump(o: PumpOpts): { stop: () => Promise<void>; handled: () => number } {
  let stopped = false, n = 0, lastMint = 0;
  const interval = o.intervalMs ?? 300;
  const tick = async () => {
    if (o.mintToken && Date.now() - lastMint > (o.refreshMs ?? 10 * 60_000)) { await o.spool.writeToken(o.mintToken()); lastMint = Date.now(); }
    const items = await o.spool.take();
    if (items.length) {
      const answers = await Promise.all(items.map(async (it) => ({ file: it.file, res: it.req ? await o.handle(it.req) : ({ id: it.file.replace(/\.json$/, ""), ok: false, error: { code: "usage", message: "malformed request" } } as RpcResponse) })));
      await o.spool.answer(answers);
      n += items.length;
      o.onLog?.(answers.map((a, i) => `[capcomd] ${items[i]!.req?.op ?? "?"} → ${a.res.ok ? "ok" : `error ${(a.res as any).error.reason ?? (a.res as any).error.code}: ${String((a.res as any).error.message).slice(0, 300)}`}`));
    }
    if (o.spool.logs) { const l = await o.spool.logs(); if (l.length) o.onLog?.(l); }
  };
  const loop = (async () => {
    while (!stopped) {
      try { await tick(); } catch (e) { o.onLog?.([`[capcomd] pump error: ${String((e as Error)?.message ?? e).slice(0, 200)}`]); }
      await new Promise((r) => setTimeout(r, interval));
    }
    try { await tick(); } catch {} // answer anything that raced the stop
  })();
  return { stop: async () => { stopped = true; await loop; }, handled: () => n };
}
