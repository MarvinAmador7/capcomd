// The agent seam conformance suite (spec §14.2, §7.3): what every agent provider must do, as cases a runner can report
// one by one. Every method but `available` is pure, so no case runs a CLI: `describe` and its tool policy, `command`
// writing to `ctx.jsonl`, `parse` redacting and refusing foreign lines, the turn limit, `outcome`, and the recorded
// streams a plugin brings replayed through `parse` and `outcome`. `testkit.conformance.agent` registers them as bun
// tests; `capcomd plugins validate --conformance` runs them (with no streams) and prints each result.
import type { AgentCommandCtx, AgentConfig, AgentProvider, AgentRunState } from "./seams";
import { envPrefixesIssue } from "./seams";
import type { ConformanceResult } from "./conformance";

/** A recorded stream (the CLI's JSONL output, as text), and optionally what it must replay to. */
export type AgentStream = string | {
  /** A name for the case (default: its position). */
  name?: string;
  text: string;
  /** Fields the run's state must have after the last line (the golden `AgentRunState`). */
  state?: Partial<AgentRunState>;
  /** `outcome(state, exitCode)` after the last line; `exitCode` defaults to 0. */
  outcome?: { ok: boolean; stopReason?: string };
  exitCode?: number;
};

export interface AgentConformanceOptions {
  /** The seam's declared name: `describe().name` must equal it. */
  name?: string;
  /** Recorded streams of the provider's CLI (spec §14.2). */
  streams?: readonly AgentStream[];
}

/** Tools that change files or run work commands: never in an `orchestrate` allowlist (§16.1). */
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];
const CANARY = "conformance-canary-7f3a9c";

const fail = (message: string): never => { throw new Error(message); };
const equal = (a: unknown, b: unknown, what: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const fresh = (): AgentRunState => ({ events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false });
const cfg = (c: Partial<AgentConfig> = {}): AgentConfig => ({ credentialMode: "auto", ...c });
const ctx = (c: Partial<AgentConfig> = {}): AgentCommandCtx => ({ bin: "/opt/agent/bin/agent", repo: "/work/repo", promptFile: "/work/prompt.txt", jsonl: "/work/agent.jsonl", errFile: "/work/agent.err", dir: "/work", cfg: cfg(c) });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every string in an event, keys aside. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

function replay(p: AgentProvider, text: string, redact = (s: string) => s) {
  const state = fresh();
  const lines = text.split("\n").filter((l) => l.trim());
  const events = lines.map((l, i) => {
    try { return p.parse(l, redact, state, cfg()); } catch (e) { return fail(`parse threw on line ${i + 1}: ${(e as Error).message}`); }
  });
  return { state, events, lines };
}

interface Case { name: string; run(p: AgentProvider, o: AgentConformanceOptions): void }

export const AGENT_CASES: readonly Case[] = [
  { name: "describe() names the seam and is pure (§7.3)", run(p, o) {
    const d = p.describe();
    if (o.name !== undefined) equal(d.name, o.name, "describe().name");
    for (const k of ["name", "label", "bin", "pinnedVersion", "secretName", "apiHost"] as const) if (typeof d[k] !== "string" || !d[k]) fail(`describe().${k} must be a non-empty string`);
    // How the CLI is installed: an npm package, or release archives checked by their sha256 (exactly one).
    if ((d.npmPackage !== undefined) === (d.install !== undefined)) fail("describe() must give exactly one of npmPackage and install");
    if (d.npmPackage !== undefined && (typeof d.npmPackage !== "string" || !d.npmPackage)) fail("describe().npmPackage must be a non-empty string");
    if (d.install !== undefined) {
      const i = d.install;
      if (i?.kind !== "archive" || typeof i.member !== "string" || !i.member) fail("describe().install must be {kind: \"archive\", member, assets}");
      for (const arch of ["x86_64", "aarch64"] as const) {
        const a = i.assets?.[arch];
        if (!a || typeof a.url !== "string" || !a.url.startsWith("https://") || typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) fail(`describe().install.assets.${arch} must be an https url and a sha256`);
      }
    }
    if (!Array.isArray(d.efforts) || d.efforts.some((e) => typeof e !== "string" || !e)) fail("describe().efforts must be a list of levels");
    if (d.defaultEffort !== null && !d.efforts.includes(d.defaultEffort)) fail(`describe().defaultEffort ${JSON.stringify(d.defaultEffort)} isn't one of its efforts`);
    if (!Array.isArray(d.loginEgress)) fail("describe().loginEgress must be a list of hosts");
    const prefixes = envPrefixesIssue(d.envPrefixes);
    if (prefixes) fail(prefixes);
    if (d.logins !== undefined) {
      if (!Array.isArray(d.logins) || !d.logins.length) fail("describe().logins must be a non-empty list when given");
      const names = new Set<string>();
      for (const l of d.logins) {
        if (typeof l?.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(l.name) || names.has(l.name)) fail(`describe().logins: ${JSON.stringify(l?.name)} must be a unique lowercase name`);
        names.add(l.name);
        if (typeof l.label !== "string" || !l.label) fail(`describe().logins.${l.name}.label must be a non-empty string`);
        if (!Array.isArray(l.egress) || l.egress.some((h: unknown) => typeof h !== "string" || !h)) fail(`describe().logins.${l.name}.egress must be a list of hosts`);
        if (l.refused !== undefined && (typeof l.refused !== "string" || !l.refused)) fail(`describe().logins.${l.name}.refused must be a sentence`);
        if (l.metered !== undefined && typeof l.metered !== "boolean") fail(`describe().logins.${l.name}.metered must be a boolean`);
      }
      if (d.logins.every((l) => l.refused)) fail("describe().logins must have one login capcomd can make");
    }
    equal(p.describe(), d, "a second describe()");
  } },
  { name: "toolPolicies.orchestrate contains no edit or write tool (§16.1)", run(p) {
    const o = p.describe().toolPolicies?.orchestrate;
    if (!o || !Array.isArray(o.allowed) || !Array.isArray(o.disallowed)) fail("describe().toolPolicies.orchestrate must have allowed and disallowed lists");
    const editing = o!.allowed.filter((t) => EDIT_TOOLS.includes(t));
    if (editing.length) fail(`the orchestrate allowlist names ${editing.join(", ")}`);
    // With no allowlist the limit is the CLI's own: a read-only sandbox, or command rules that refuse at least the
    // commands that land code (commits and pushes).
    if (o!.denyCommands !== undefined && (!Array.isArray(o!.denyCommands) || o!.denyCommands.some((c) => typeof c !== "string" || !c.trim()))) fail("toolPolicies.orchestrate.denyCommands must be a list of command prefixes");
    const denies = (c: string) => (o!.denyCommands ?? []).some((d) => c === d || c.startsWith(`${d} `));
    if (!o!.allowed.length && o!.sandbox !== "read-only" && !(denies("git commit") && denies("git push")))
      fail(`an orchestrate policy with no allowlist needs sandbox "read-only" or denyCommands that refuse git commit and git push (got sandbox ${JSON.stringify(o!.sandbox ?? null)})`);
  } },
  { name: "command sends stdout to ctx.jsonl (§7.3)", run(p) {
    const c = ctx();
    const line = p.command(c, q);
    if (typeof line !== "string" || !line.trim()) fail("command() must return a shell line");
    if (!new RegExp(`(^|[^0-9&])>\\s*${escape(q(c.jsonl))}`).test(line)) fail(`command() doesn't redirect stdout to ${q(c.jsonl)}: ${line}`);
  } },
  { name: "parse returns null for a partial or foreign line", run(p) {
    for (const l of ["{partial", "not json", "42", '"text"', "null"]) {
      let ev: unknown;
      try { ev = p.parse(l, (s) => s, fresh(), cfg()); } catch (e) { fail(`parse threw on ${JSON.stringify(l)}: ${(e as Error).message}`); }
      if (ev !== null) fail(`parse(${JSON.stringify(l)}) must be null, got ${JSON.stringify(ev)}`);
    }
  } },
  { name: "parse passes every string through redact (§7.3, §11.5)", run(p) {
    const text = `the key is ${CANARY}`;
    const line = JSON.stringify({
      type: "assistant", subtype: "x", text, result: text, message: { id: "m1", content: [{ type: "text", text }, { type: "tool_use", id: "t1", name: "Read", input: { path: text } }] },
      item: { type: "agent_message", text }, error: { message: text },
    });
    const ev = p.parse(line, (s) => s.split(CANARY).join("[REDACTED]"), fresh(), cfg());
    if (ev && strings(ev).some((s) => s.includes(CANARY))) fail("an event carries a string that didn't pass through redact");
  } },
  { name: "the turn limit stops the agent: its guard, or the CLI's own flag", run(p) {
    const max = 7919;
    const over = p.guard({ ...fresh(), turns: max + 1 }, cfg({ maxTurns: max }));
    if (over !== null && typeof over !== "string") fail("guard() must return a reason or null");
    if (over === null && !p.command(ctx({ maxTurns: max }), q).includes(String(max))) fail(`neither guard() stops at maxTurns=${max} nor does command() pass it to the CLI`);
    const under = p.guard({ ...fresh(), turns: 1 }, cfg({ maxTurns: max }));
    if (under !== null) fail(`guard() stops an agent under its limits: ${under}`);
  } },
  { name: "outcome: a timeout (exit 124) and an unfinished run are not ok", run(p) {
    const done = { ...fresh(), done: true, stopReason: "success" };
    const t = p.outcome(done, 124);
    if (typeof t?.ok !== "boolean" || typeof t.stopReason !== "string") fail("outcome() must return {ok, stopReason}");
    if (t.ok) fail("outcome(state, 124) must not be ok");
    if (p.outcome(fresh(), 1).ok) fail("outcome of a run that never finished, exit 1, must not be ok");
  } },
];

/** The cases for `p`: the fixed ones, then one per recorded stream. */
export function agentCases(p: AgentProvider, opts: AgentConformanceOptions = {}): Array<{ name: string; run(): void }> {
  const fixed = AGENT_CASES.map((c) => ({ name: c.name, run: () => c.run(p, opts) }));
  const streams = (opts.streams ?? []).map((s, i) => {
    const st = typeof s === "string" ? { text: s } : s;
    return {
      name: `a recorded stream replays through parse and outcome: ${st.name ?? `#${i + 1}`}`,
      run() {
        const r = replay(p, st.text, (x) => x.split(CANARY).join("[REDACTED]"));
        if (!r.lines.length) fail("the stream is empty");
        if (r.events.every((e) => e === null)) fail("parse read none of the stream's lines");
        if (st.state) for (const [k, v] of Object.entries(st.state)) equal((r.state as unknown as Record<string, unknown>)[k], v, `state.${k}`);
        const out = p.outcome(r.state, st.exitCode ?? 0);
        if (st.outcome) { equal(out.ok, st.outcome.ok, "outcome().ok"); if (st.outcome.stopReason !== undefined) equal(out.stopReason, st.outcome.stopReason, "outcome().stopReason"); }
      },
    };
  });
  return [...fixed, ...streams];
}

/** Run the whole suite against `p` and report every case (`capcomd plugins validate --conformance`). */
export function runAgentConformance(p: AgentProvider, opts: AgentConformanceOptions = {}): ConformanceResult[] {
  return agentCases(p, opts).map((c) => {
    const t0 = Date.now();
    try { c.run(); return { name: c.name, ok: true, skipped: false, ms: Date.now() - t0, message: null }; } catch (e) {
      return { name: c.name, ok: false, skipped: false, ms: Date.now() - t0, message: e instanceof Error ? e.message : String(e) };
    }
  });
}
