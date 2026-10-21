import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeEvents, parseEvents } from "./events";
import { parseTrace } from "./trace";
import { agentsFromTrace, attachErrorKinds, flattenAgents, nodesFrom, parseTree } from "./tree";
import type { AgentNode, PendingApproval, RunData, RunEvent, Trace } from "./types";

export const FIXTURE_DIR = resolve(import.meta.dir, "../../fixtures");

export function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/**
 * A fixture is a folder with any of: trace.ndjson, events.ndjson, tree.json, status.json, meta.json,
 * or inspect.ndjson (a recorded `capcomd inspect <id> --json --follow` stream, which wins).
 */
export function loadFixture(name: string): RunData {
  const dir = join(FIXTURE_DIR, name);
  if (!existsSync(dir)) throw new Error(`no fixture "${name}" (have: ${listFixtures().join(", ")})`);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const meta = read("meta.json") ? JSON.parse(read("meta.json")) : {};
  if (read("inspect.ndjson")) {
    const s = new InspectState(meta.runId ?? "unknown", `fixture:${name}`);
    for (const line of read("inspect.ndjson").split("\n")) s.line(line);
    return s.data();
  }
  return assemble({ trace: read("trace.ndjson"), events: read("events.ndjson"), tree: read("tree.json"), status: read("status.json"), source: `fixture:${name}`, meta });
}

export function assemble(o: { trace: string; events: string; tree: string; status?: string; source: string; runId?: string; meta?: any }): RunData {
  const trace = parseTrace(o.trace, o.runId ?? o.meta?.runId);
  const status = o.status ? safe(o.status)?.run ?? safe(o.status) : null;
  return build({ runId: o.runId ?? o.meta?.runId, source: o.source, trace, events: parseEvents(o.events), tree: parseTree(o.tree), status, meta: o.meta });
}

function build(o: { runId?: string; source: string; trace: Trace | null; events: RunEvent[]; tree: AgentNode[]; status: any; meta?: any }): RunData {
  const { trace, events, status } = o;
  const runId = o.runId ?? status?.runId ?? trace?.runId ?? "unknown";
  const started = events.find((e) => e.type === "run.started");
  const result = [...events].reverse().find((e) => e.type === "run.result" || (e.type.startsWith("run.") && /completed|failed|cancelled/.test(e.type)));
  const err = events.find((e) => e.type === "cli.error");
  const evState = (result?.data.state as string) ?? (result ? result.type.slice(4) : err ? "failed" : undefined);
  const scopeState = status?.scope?.state as string | undefined;
  if (o.tree.length) attachErrorKinds(trace, new Map(flattenAgents(o.tree).map((a) => [a.agentId, a])));
  return {
    runId, source: o.source, goal: status?.goal ?? (started?.data.goal as string) ?? o.meta?.goal,
    state: evState ?? scopeState ?? status?.state ?? o.meta?.state ?? (events.length ? undefined : "trace only"),
    trace, events, agents: o.tree.length ? o.tree : agentsFromTrace(trace), agentsFromTree: o.tree.length > 0,
    pendingApprovals: pending(status),
  };
}

function pending(status: any): PendingApproval[] {
  const list = Array.isArray(status?.pendingApprovals) ? status.pendingApprovals : [];
  return list.map((p: any) => ({ taskId: String(p.taskId), kind: p.kind, targetBranch: p.targetBranch, since: typeof p.since === "number" ? p.since : Date.parse(p.since) })).filter((p: PendingApproval) => Number.isFinite(p.since));
}

const safe = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Folds a `capcomd inspect --json --follow` stream (docs/output-contract.md) into RunData:
 * a snapshot, then `event` lines, `inspect.tree` pushes, and `inspect.end`. Events are deduped on
 * (entity, entitySeq), so a reconnect with --since-seq that replays an event is harmless.
 */
export class InspectState {
  lastSeq = 0;
  ended = false;
  private trace: Trace | null = null;
  private tree: AgentNode[] = [];
  private status: any = null;
  private events: RunEvent[] = [];
  constructor(private runId: string, private source: string) {}

  line(text: string): boolean {
    const v = safe(text.trim());
    if (!v || typeof v !== "object") return false;
    if (v.type === "inspect.snapshot") {
      if (v.trace) this.trace = parseTrace(JSON.stringify({ trace: v.trace }), this.runId);
      if (v.tree) this.tree = nodesFrom(v);
      if (v.status) this.status = v.status;
      this.add(parseEvents(JSON.stringify({ events: v.events ?? [] })));
      if (typeof v.seq === "number") this.lastSeq = Math.max(this.lastSeq, v.seq);
      return true;
    }
    if (v.type === "inspect.tree") { this.tree = nodesFrom(v); return true; }
    // Spans are written as they end: the follow stream re-sends the trace whenever it grows.
    if (v.type === "inspect.trace" && v.trace) { this.trace = parseTrace(JSON.stringify({ trace: v.trace }), this.runId); return true; }
    if (v.type === "inspect.end") { this.ended = true; return true; }
    if (v.type === "event" && v.event) {
      this.add(parseEvents(JSON.stringify({ events: [v.event] })));
      if (typeof v.seq === "number") this.lastSeq = Math.max(this.lastSeq, v.seq);
      return true;
    }
    return false;
  }

  private add(evs: RunEvent[]) { this.events = mergeEvents(this.events, evs); }

  data(): RunData {
    return build({ runId: this.runId, source: this.source, trace: this.trace, events: this.events, tree: this.tree, status: this.status });
  }
}

const cliBin = () => (process.env.CAPCOMD_BIN ?? `bun ${resolve(import.meta.dir, "../../../../src/cli/index.ts")}`).split(" ");

/** One-shot: `capcomd inspect <runId> --json`. */
export async function loadLive(runId: string): Promise<RunData> {
  const p = Bun.spawn([...cliBin(), "inspect", runId, "--json"], { stdout: "pipe", stderr: "ignore" });
  const s = new InspectState(runId, "live");
  for (const l of (await new Response(p.stdout).text()).split("\n")) s.line(l);
  await p.exited;
  return s.data();
}

/**
 * Live: one `capcomd inspect <runId> --json --follow` stream. When it closes (timeout, engine
 * restart, inspect.end), reconnect with `--since-seq <last seq>` after `retryMs`; the new snapshot
 * also refreshes trace, tree and status. Returns a stop function.
 */
export function followLive(runId: string, onData: (d: RunData) => void, o: { retryMs?: number; onError?: (e: string) => void; env?: Record<string, string>; cwd?: string } = {}): () => void {
  const state = new InspectState(runId, "live");
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const connect = async () => {
    if (stopped) return;
    const args = ["inspect", runId, "--json", "--follow", ...(state.lastSeq ? ["--since-seq", String(state.lastSeq)] : [])];
    proc = Bun.spawn([...cliBin(), ...args], { stdout: "pipe", stderr: "pipe", cwd: o.cwd, env: o.env ? { ...process.env, ...o.env } : undefined });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      let changed = false;
      while ((i = buf.indexOf("\n")) >= 0) { changed = state.line(buf.slice(0, i)) || changed; buf = buf.slice(i + 1); }
      if (changed && !stopped) onData(state.data());
    }
    const code = await proc.exited;
    if (code !== 0 && !stopped) o.onError?.(`capcomd inspect exited ${code}: ${(await new Response(proc.stderr as ReadableStream).text()).slice(0, 300)}`);
    if (!stopped) setTimeout(connect, o.retryMs ?? 1000);
  };
  void connect();
  return () => { stopped = true; proc?.kill(); };
}
