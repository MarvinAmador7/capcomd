// context (ADR-025 §5.1, §5.2, §6.1, §10, steps 1-4 and 6): the kernel's context router. As the one agent.preparing
// listener it composes a profile's context providers into the brief (src/context/brief.ts), appended to the agent's
// prompt after its profile's own, with the context layer's skills (src/context/skills.ts: the doctrine, and the
// routing paragraph for an agent that writes run notes), each pinned by the sha256 of its text, and leaves the bundles
// the brief cites (a brain at its commit) for the attempt's runner to place in the sandbox; an agent whose profile has
// no `context` block gets nothing and costs nothing. As an agent.changed
// listener it collects the lessons an agent proposed in its result (`result.data.context`) when it ends: attributed to
// the token that wrote the result, checked by the seeded secret scan, kept as candidates of the run in kv
// `_context/<agentId>` (src/context/capture.ts); a consolidator's answer isn't collected (the kernel stages it on its
// branch, src/context/consolidator.ts), only told. Its events, on the run's stream: `plugin.context.loaded` (what a
// brief held), `plugin.context.skipped` (a provider left out, and why), `plugin.context.proposed` (a candidate kept),
// `plugin.context.refused` (one refused, and why, never its text) and `plugin.context.staged` (what a consolidator's
// branch changes in the project's memory). Its commands:
//   capcomd context brief <profile> [--run <runId>] [--review]   the brief that profile's agents start with now
//   capcomd context lint [--fix] [--base <ref>] [--run <runId>]  check .capcomd/context/ (src/context/lint.ts)
//   capcomd context brain add <name> <repo> [--branch <b>] [--bundle <dir>]   map a brain, pinned at the branch's tip
//   capcomd context brain list | remove <name>                   the project's brains (src/context/groundray.ts)
// It is loaded in every process an agent is prepared in (the daemon, a run's driver) and in the CLI; agents end in the
// daemon, so that is where capture runs.
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { definePlugin, type Envelope, type PluginContext } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { Agent, PinnedSpec } from "../../packages/plugin/src/shapes";
import { RelayError, SCHEMA } from "../core/errors";
import { VERSION } from "../utils/self";
import type { ScopeAgent } from "../actors/scope";
import type { Brief } from "../context/brief";
import type { CaptureRecord } from "../context/capture";
import { CONSOLIDATOR_PROFILE } from "../context/consolidate";
import { preparingAgent, SKILL_BYTES_MAX, SKILLS_MAX } from "./hooks";

const SUMMARY = "The project's context (ADR-025): the brief a profile's agents start with, and lint for .capcomd/context/; brain mappings";
const USAGE = [
  "capcomd context brief <profile> [--run <runId>] [--review] [--json]",
  "capcomd context lint [--fix] [--base <ref>] [--run <runId>] [--dir <repo>] [--json]",
  "capcomd context brain add <name> <repo> [--branch <branch>] [--bundle <dir>] [--json]",
  "capcomd context brain list [--json]",
  "capcomd context brain remove <name> [--json]",
];

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "context", version: VERSION,
  description: "The context router: briefs each agent whose profile has a context block with an index of its providers' items (the project's memory, a company's facts), never their bodies, and keeps the lessons agents propose as candidates of their run.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./context.ts" },
  scopes: ["steer"],
  // After the orchestration skill's listener (§6.3), so the context skills fit in the room that skill leaves: one that
  // didn't fit would cost the agent a context skill (this listener leaves it out), never its orchestration skill.
  after: ["skill-orchestration"],
  // Open: a brief that can't be built leaves the agent as it was without one (its providers' failures are already
  // named in the header the router writes; this is the router itself failing), never an agent that can't start.
  // agent.changed is observe, so open too: collecting an agent's lessons never holds up anything.
  contributes: {
    hooks: { "agent.preparing": { timeoutMs: 30_000, failure: "open" }, "agent.changed": {} },
    events: ["loaded", "skipped", "proposed", "refused", "staged"],
    cli: [{ name: "context", summary: SUMMARY }],
  },
};

/** What the brief is built from besides the payload (a test replaces it). */
export const contextKernel = {
  /** The agent's record as the kernel prepares it (src/primitives/ops.ts `agentPreparing`), else read from the engine. */
  agent: async (runId: string, agentId: string): Promise<Pick<ScopeAgent, "contract"> & { limits?: Pick<ScopeAgent["limits"], "allowSpawn"> }> => {
    const p = preparingAgent.getStore();
    if (p && p.runId === runId && p.agentId === agentId) return p.record as ScopeAgent;
    return (await import("../primitives/ops")).getAgentOrThrow(runId, agentId);
  },
  scope: async (...a: Parameters<typeof import("../context/brief").runScope>) => (await import("../context/brief")).runScope(...a),
  providers: async () => (await import("../context/providers")).contextProviders(),
  /** The agent providers' own credentials in this process: never in a brief. */
  secrets: async (): Promise<string[]> => {
    const { agentSeams } = await import("./agents");
    return agentSeams().map((s) => process.env[s.describe().secretName]).filter((v): v is string => !!v);
  },
};

/** What capture reads and writes besides the payload, in the run's scope (a test replaces it). */
export const captureKernel = {
  /** The result the agent declared (kv `_result/<agentId>`) and who wrote it: the `sub` of the token that called
   *  `capcomd result` (src/subagents/rpc.ts), the only attribution capture takes. */
  declared: async (runId: string, agentId: string): Promise<{ writer: string | null; value: unknown } | null> => {
    const r = await (await import("../primitives/state")).kvGet(runId, `_result/${agentId}`);
    return r && !(r as { deleted?: boolean }).deleted && r.value !== null ? { writer: (r.writer as string | null) ?? null, value: r.value } : null;
  },
  /** The agent's result as the kernel recorded it (a consolidator's staging is in it: `context`, `branch`, `commit`). */
  result: async (runId: string, agentId: string): Promise<Record<string, unknown> | null> => (await (await import("../primitives/ops")).getAgentOrThrow(runId, agentId)).result ?? null,
  /** The agent's pinned spec (its context block's limits). */
  spec: async (runId: string, agentId: string): Promise<PinnedSpec> => {
    const { pinnedOf } = await import("./shapes");
    return pinnedOf(await (await import("../primitives/ops")).getAgentOrThrow(runId, agentId));
  },
  /** How many candidates the run holds. */
  taken: async (runId: string): Promise<number> => {
    const { CANDIDATES_KV } = await import("../context/capture");
    const { entries } = await (await import("../primitives/state")).kvList(runId, CANDIDATES_KV);
    return (entries as Array<{ value?: { candidates?: unknown[] } | null }>).reduce((n, e) => n + (Array.isArray(e.value?.candidates) ? e.value.candidates.length : 0), 0);
  },
  /** Keep one agent's record, once: false when it is there already (a replayed change). */
  record: async (runId: string, rec: CaptureRecord): Promise<boolean> => {
    const { CANDIDATES_KV } = await import("../context/capture");
    try {
      await (await import("../primitives/state")).kvWrite(runId, { k: `${CANDIDATES_KV}${rec.agentId}`, value: rec, expect: 0, writer: "capcomd" });
      return true;
    } catch (e) {
      if (e instanceof RelayError && e.code === "conflict") return false;
      throw e;
    }
  },
  /** Every secret value the kernel put in the run (src/context/scan.ts), the forge's for its repository too. */
  secrets: async (runId: string): Promise<string[]> => {
    const { runSecrets } = await import("../context/scan");
    const cfg = await (await import("../merge/run-config")).mergeConfigFor(runId).catch(() => null);
    return runSecrets({ runId, remote: cfg?.remote ?? null });
  },
};

/** One run's captures at a time (in this process), so the run's limit on lessons counts each agent's once. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(runId) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(runId, next);
  const done = () => { if (queues.get(runId) === next) queues.delete(runId); };
  next.then(done, done);
  return next;
}

type Emit = (type: string, text: string, data: Record<string, unknown>, key?: string) => Promise<unknown>;

/**
 * The lessons agent `agent` proposed in its result, now that it ended (ADR-025 §5.1): read from the record its token
 * wrote, never from the hook's payload (which only says there is something to read, and is redacted on its way here,
 * so a secret in it would be hidden from the scan); attributed to the token's `sub` and stamped from the kernel's
 * records; each kept or refused once (the run's record of the agent is written only if it isn't there yet).
 */
export async function collect(agent: Pick<Agent, "id" | "runId" | "profile" | "model">, emit: Emit): Promise<CaptureRecord | null> {
  return serial(agent.runId, async () => {
    const declared = await captureKernel.declared(agent.runId, agent.id);
    // Only what the agent's own token wrote: a handed-off agent's result is its successor's, collected at its end.
    if (!declared || declared.writer !== agent.id) return null;
    const raw = (declared.value as { data?: { context?: unknown } } | null)?.data?.context;
    if (!Array.isArray(raw) || !raw.length) return null;
    const { capture } = await import("../context/capture");
    const { secretScan } = await import("../context/scan");
    const { limitsFor } = await import("../context/limits");
    const spec = await captureKernel.spec(agent.runId, agent.id).catch(() => ({}) as PinnedSpec);
    const model = agent.model ?? spec.model ?? null;
    const { limits } = limitsFor(model, spec.context);
    const room = limits.proposalsPerRun === null ? null : Math.max(0, limits.proposalsPerRun - (await captureKernel.taken(agent.runId)));
    const at = new Date().toISOString();
    const origin = { runId: agent.runId, agentId: agent.id, profile: agent.profile ?? "", model, image: null };
    const r = capture({ raw, origin, at, scan: secretScan(await captureKernel.secrets(agent.runId)), itemBytes: limits.itemBytes, room });
    const rec: CaptureRecord = { agentId: agent.id, profile: origin.profile, at, candidates: r.accepted, refused: r.refused.map(({ n, reason }) => ({ n, reason })), ignored: r.ignored };
    if (!(await captureKernel.record(agent.runId, rec))) return null;
    for (const c of r.accepted) await emit("proposed", `${agent.id} proposed lesson ${c.id} for the project's memory: a candidate until a reviewed change lands it.`, { agentId: agent.id, profile: origin.profile, candidate: c, ...(r.ignored.length ? { ignored: r.ignored } : {}) });
    for (const x of r.refused) await emit("refused", `${agent.id}'s lesson ${x.n} was refused: it ${x.what}.`, { agentId: agent.id, profile: origin.profile, n: x.n, reason: x.reason });
    return rec;
  });
}

/** The repository `cwd` is in (its nearest directory with a .git), else `cwd`. */
function repoRoot(cwd: string): string {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return resolve(cwd);
  }
}

/** Whether an item's outcome is a passed verify or a landed merge of run `runId`. */
async function outcomesOf(runId: string) {
  const { existingActor } = await import("../core/relay");
  const scope = /^run-[A-Za-z0-9_-]+$/.test(runId) ? await existingActor("scope", [runId]) : null;
  if (!scope) throw new RelayError("not_found", `no run ${runId}`, "See your runs with `capcomd runs`.");
  return (await import("../context/consolidator")).outcomeIn((await scope.listOps({})) as import("../context/consolidator").RunOp[]);
}

/** `capcomd context lint` (src/context/lint.ts): the problems as an error, else the warnings and what it wrote. */
async function lint(flags: Record<string, string | boolean | string[]>): Promise<Envelope> {
  const { INDEX_FILE, indexLinked, lintContext, readContextAt, readContextDir } = await import("../context/lint");
  const { DEFAULT_LIMITS } = await import("../context/limits");
  const { runSecrets, secretScan } = await import("../context/scan");
  const root = typeof flags.dir === "string" ? resolve(flags.dir) : repoRoot(process.cwd());
  const files = readContextDir(root);
  if (!files.length) return { schema: SCHEMA, ok: true, root, items: 0, errors: [], warnings: [], text: `No .capcomd/context/ in ${root}: nothing to lint.` };
  let base = null;
  if (typeof flags.base === "string") {
    try { base = readContextAt(root, flags.base); } catch (e) { throw new RelayError("usage", (e as Error).message, "Name a branch or a commit of this repository: --base main."); }
  }
  const runId = typeof flags.run === "string" ? flags.run : null;
  const fix = flags.fix === true;
  const r = lintContext({
    files, base, fix, scan: secretScan(await runSecrets({ runId })), outcome: runId ? await outcomesOf(runId) : null,
    itemBytes: DEFAULT_LIMITS.itemBytes, descriptionChars: DEFAULT_LIMITS.descriptionChars,
  });
  let written = false;
  // Never through a link (lint has said so already): it could write anywhere the link points.
  if (fix && !r.index.current && !indexLinked(files)) {
    mkdirSync(dirname(join(root, INDEX_FILE)), { recursive: true });
    writeFileSync(join(root, INDEX_FILE), r.index.text);
    written = true;
  }
  const list = (ps: typeof r.errors) => ps.map((p) => `  ${p.file}: ${p.message}`).join("\n");
  if (r.errors.length) {
    throw new RelayError("run_failed", `context lint: ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"} in ${root}${written ? " (index.md rewritten)" : ""}:\n${list(r.errors)}`,
      "Fix them and run `capcomd context lint` again; `--fix` rewrites index.md.");
  }
  const said = `context lint: ${r.items} item${r.items === 1 ? "" : "s"}, no problems${written ? "; index.md rewritten" : ""}.`;
  return {
    schema: SCHEMA, ok: true, root, items: r.items, errors: [], warnings: r.warnings, index: { path: r.index.path, current: r.index.current || written, written },
    text: r.warnings.length ? `${said}\n${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}:\n${list(r.warnings)}` : said,
  };
}

/** The brief for an agent of `profile` with `spec`, in run `runId` (null: the project as this process sees it). */
export async function briefFor(o: { runId: string | null; agentId: string | null; profile: string | null; spec: PinnedSpec; role: "work" | "review" }): Promise<Brief> {
  const { buildBrief } = await import("../context/brief");
  return buildBrief({
    context: o.spec.context ?? {}, model: o.spec.model ?? null, role: o.role,
    scope: await contextKernel.scope(o.runId, { id: o.agentId, profile: o.profile }, o.spec.profile?.version ?? 1),
    providers: await contextKernel.providers(), secrets: await contextKernel.secrets(),
  });
}

const sha = (r: string) => r.slice(0, 12);
const usage = () => new RelayError("usage", `usage: ${USAGE.join("\n       ")}`, "Name a profile (`capcomd context brief worker`), check .capcomd/context/ (`capcomd context lint`), or map a brain (`capcomd context brain add acme <repo>`).");

/** `capcomd context brain …`: the brains the project maps (src/context/groundray.ts). */
async function brainCommand(args: string[], flags: Record<string, unknown>): Promise<Envelope> {
  const G = await import("../context/groundray");
  const verb = args[1];
  if (verb === "list" && args.length === 2) {
    const { path, brains } = G.listBrains();
    const rows = Object.entries(brains).map(([name, b]) => ({ name, ...b }));
    const text = rows.length ? rows.map((b) => `${b.name}  ${b.repo} (${b.branch} at ${sha(b.commit)})${b.title ? `  ${b.title}` : ""}`).join("\n")
      : `This project maps no brain (${path}). Map one: capcomd context brain add <name> <repository>`;
    return { schema: SCHEMA, ok: true, path, brains: rows, text };
  }
  if (verb === "add" && args.length === 4) {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const branch = str(flags.branch), bundle = str(flags.bundle);
    const r = await G.addBrain({ name: args[2]!, repo: args[3]!, ...(branch ? { branch } : {}), ...(bundle ? { bundle } : {}) });
    const moved = r.previous ? (r.previous.commit === r.brain.commit ? ` (already at ${sha(r.brain.commit)})` : ` (was ${sha(r.previous.commit)})`) : "";
    return {
      schema: SCHEMA, ok: true, name: r.name, brain: r.brain, items: r.items, truncated: r.truncated, path: r.path,
      text: `Brain ${r.name}: ${r.brain.repo}, ${r.brain.branch} at ${sha(r.brain.commit)}${moved}, ${r.items} item${r.items === 1 ? "" : "s"}${r.truncated ? " (more than capcomd reads)" : ""}. ` +
        `Profiles name it with context: {providers: [{name: groundray, brain: ${r.name}}]}; runs started from now on read this commit. Run this again to move it to the branch's tip.`,
    };
  }
  if (verb === "remove" && args.length === 3) {
    const r = G.removeBrain(args[2]!);
    return { schema: SCHEMA, ok: true, name: args[2], removed: r.removed, path: r.path, text: `Brain ${args[2]} is no longer mapped (runs already started keep the commit they recorded).` };
  }
  throw usage();
}

/** A context event on the run's stream; one that can't be recorded is logged, never thrown. `key`: one event per key. */
const emitter = (ctx: PluginContext, runId: string, entity: string): Emit => (type, text, data, key) =>
  ctx.events.emit({ type, stream: runId, entity, text, data }, key ? { key } : undefined).catch((e: unknown) => ctx.log.warn("could not record a context event", { type, error: (e as Error)?.message ?? String(e) }));

/**
 * A consolidator's end (ADR-025 §5.2): what the kernel staged on its branch, from its result (`result.context`, the
 * kernel's own record of the staging, src/primitives/ops.ts `consolidatedOf`): `plugin.context.staged` with the branch,
 * the commit and each change, and `plugin.context.refused` per change it refused (a number and a reason). Keyed, so a
 * replayed change records them once.
 */
export async function staged(agent: Pick<Agent, "id" | "profile">, result: Record<string, unknown> | null | undefined, emit: Emit): Promise<void> {
  const c = result?.context as { applied?: Array<{ op: string; id: string; target?: string }>; refused?: Array<{ n: number; reason: string }> } | undefined;
  if (!c || typeof c !== "object") return;
  const commit = typeof result?.commit === "string" ? result.commit : null, branch = typeof result?.branch === "string" ? result.branch : null;
  const applied = Array.isArray(c.applied) ? c.applied : [], refused = Array.isArray(c.refused) ? c.refused : [];
  const changes = applied.filter((x) => x.op !== "duplicate");
  if (commit && branch) {
    await emit("staged", `${agent.id} staged ${changes.length} change${changes.length === 1 ? "" : "s"} to the project's memory on ${branch}: it lands through a reviewed merge.`,
      { agentId: agent.id, profile: agent.profile, branch, commit, applied }, `staged:${agent.id}`);
  }
  for (const x of refused) await emit("refused", `${agent.id}'s memory change ${x.n} was refused (${x.reason}).`, { agentId: agent.id, profile: agent.profile, n: x.n, reason: x.reason }, `staged-refused:${agent.id}:${x.n}`);
}

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("agent.preparing", async (call) => {
      const { agent, spec } = call.payload;
      // A fake agent (the tests' and the dry run's) reads no prompt; a profile without a context block gets no brief.
      if (!spec.provider || !spec.context?.providers?.length) return { decision: "allow" };
      const a = await contextKernel.agent(agent.runId, agent.id);
      const { roleOf } = await import("../context/brief");
      const role = roleOf(a);
      const b = await briefFor({ runId: agent.runId, agentId: agent.id, profile: agent.profile, spec, role });
      // The skills it reads the brief with, so the patch stays one the kernel takes: one the payload already has by name
      // (an earlier listener's) isn't attached twice, and only those that fit the room the agent's other skills leave
      // (a profile with a context block keeps room for them, but a plugin's skills or an agent pinned before it did may
      // fill it): a refused patch would cost the agent its brief too.
      const { contextSkills } = await import("../context/skills");
      const has = call.payload.prompt.skills;
      let slots = SKILLS_MAX - has.length, bytes = SKILL_BYTES_MAX - has.reduce((n, s) => n + Buffer.byteLength(s.text), 0);
      const wanted = contextSkills({ role, maySpawn: a.limits?.allowSpawn === true }).filter((s) => !has.some((x) => x.name === s.name));
      const skills = wanted.filter((s) => {
        const size = Buffer.byteLength(s.text);
        if (slots < 1 || size > bytes) return false;
        slots--; bytes -= size;
        return true;
      });
      if (skills.length < wanted.length) ctx.log.warn("an agent's other skills leave no room for a context skill: it starts without it", { agentId: agent.id, left: wanted.filter((s) => !skills.includes(s)).map((s) => s.name) });
      const loaded = b.providers.filter((p) => p.state === "loaded").map((p) => `${p.name} at ${sha(p.revision)}`);
      const emit = emitter(ctx, agent.runId, agent.id);
      await emit("loaded", `${agent.id} starts with ${b.loaded} of ${b.total} context lines${loaded.length ? ` (${loaded.join(", ")})` : ""}.`, {
        agentId: agent.id, profile: agent.profile, loaded: b.loaded, total: b.total, stale: b.stale, bytes: b.bytes,
        budget: { briefBytes: b.limits.briefBytes, indexLines: b.limits.indexLines, source: b.source }, providers: b.providers,
        skills: skills.map(({ name, hash }) => ({ name, hash })),
        ...(b.bundles.length ? { bundles: b.bundles.map((x) => ({ provider: x.provider, name: x.name, commit: x.commit })) } : {}),
      });
      for (const p of b.providers) if (p.state === "skipped") await emit("skipped", `${agent.id} starts without the ${p.name} context provider (${p.reason}).`, { agentId: agent.id, profile: agent.profile, provider: p.name, reason: p.reason });
      // The bundles the brief's lines point at, for the attempt's runner to place (ADR-025 §6.2): the kernel's own
      // record of this call, left with the patch it answers.
      const kernel = preparingAgent.getStore();
      if (kernel && kernel.runId === agent.runId && kernel.agentId === agent.id) kernel.bundles = b.bundles.map((x) => ({ ...x }));
      const attach = skills.map(({ name, hash, text }) => ({ name, hash, source: "builtin" as const, text }));
      return { decision: "allow", patch: { prompt: { append: b.text, ...(attach.length ? { skills: attach } : {}) } } };
    });

    // An agent that ended with lessons in its result (`result.data.context`): collect them. It never throws: a
    // listener that failed three times running would suspend the brief with it (spec §6.5).
    ctx.hooks.on("agent.changed", async (call) => {
      const { agent, change } = call.payload;
      if (change.kind !== "ended" || change.status === "cancelled") return;
      // A consolidator's answer isn't candidates: the kernel staged it on its branch (src/context/consolidator.ts).
      if (agent.profile === CONSOLIDATOR_PROFILE) {
        await captureKernel.result(agent.runId, agent.id).then((r) => staged(agent, r, emitter(ctx, agent.runId, agent.id))).catch((e: unknown) => ctx.log.warn("could not record a consolidator's staging", { agentId: agent.id, error: (e as Error)?.message ?? String(e) }));
        return;
      }
      const data = change.result?.data as { context?: unknown } | null | undefined;
      if (!data || typeof data !== "object" || !Array.isArray(data.context)) return;
      await collect(agent, emitter(ctx, agent.runId, agent.id)).catch((e: unknown) => ctx.log.warn("could not collect an agent's lessons", { agentId: agent.id, error: (e as Error)?.message ?? String(e) }));
    });

    ctx.cli.command({
      name: "context", summary: SUMMARY, usage: USAGE,
      async run({ args, flags }) {
        if (args[0] === "lint" && args.length === 1) return lint(flags);
        if (args[0] === "brain") return brainCommand(args, flags);
        if (args[0] !== "brief" || args.length !== 2) throw usage();
        const name = args[1]!;
        const runId = typeof flags.run === "string" ? flags.run : null;
        const { resolveAgent } = await import("../profiles");
        let resolved: ReturnType<typeof resolveAgent>;
        try { resolved = resolveAgent(name); } catch (e) { throw new RelayError("usage", (e as Error).message, "See your profiles with `capcomd profiles list`."); }
        const spec = resolved.spec as unknown as PinnedSpec | undefined;
        if (!spec?.context?.providers?.length) {
          return { schema: SCHEMA, ok: true, profile: name, brief: null, text: `Profile ${name} has no context block, so its agents start with no brief. Give it one in its profile: context: {providers: [{name: memory}]}` };
        }
        const role = flags.review === true ? "review" : "work";
        const b = await briefFor({ runId, agentId: null, profile: name, spec: { ...spec, ...(resolved.profile ? { profile: resolved.profile } : {}) }, role });
        const { contextSkills } = await import("../context/skills");
        const skills = contextSkills({ role, maySpawn: spec.children?.allowSpawn === true }).map(({ name: n, hash }) => ({ name: n, hash }));
        return {
          schema: SCHEMA, ok: true, profile: name, brief: b.text, loaded: b.loaded, total: b.total, stale: b.stale, bytes: b.bytes, budget: { ...b.limits, source: b.source }, providers: b.providers, skills,
          text: `${b.text}\n\nWith the skills: ${skills.map((s) => `${s.name} (sha256 ${s.hash.slice(0, 12)})`).join(", ")}.`,
        };
      },
    });
  },
});
