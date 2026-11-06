// context (ADR-025 §6.1, §10, step 1): the kernel's context router as the one agent.preparing listener that composes a
// profile's context providers into the brief (src/context/brief.ts), appended to the agent's prompt after its profile's
// own. An agent whose profile has no `context` block gets nothing and costs nothing. Its events, on the run's stream:
// `plugin.context.loaded` (what the brief held) and `plugin.context.skipped` (a provider left out, and why). Its command:
//   capcomd context brief <profile> [--run <runId>] [--review]   the brief that profile's agents start with now
// It is loaded in every process an agent is prepared in (the daemon, a run's driver) and in the CLI.
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { PinnedSpec } from "../../packages/plugin/src/shapes";
import { RelayError, SCHEMA } from "../core/errors";
import { VERSION } from "../utils/self";
import type { ScopeAgent } from "../actors/scope";
import type { Brief } from "../context/brief";
import { preparingAgent } from "./hooks";

const SUMMARY = "The context brief a profile's agents start with: an index of the project's memory and facts (ADR-025)";
const USAGE = "capcomd context brief <profile> [--run <runId>] [--review] [--json]";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "context", version: VERSION,
  description: "The context router: briefs each agent whose profile has a context block with an index of its providers' items (the project's memory, a company's facts), never their bodies.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./context.ts" },
  scopes: ["steer"],
  // Open: a brief that can't be built leaves the agent as it was without one (its providers' failures are already
  // named in the header the router writes; this is the router itself failing), never an agent that can't start.
  contributes: {
    hooks: { "agent.preparing": { timeoutMs: 30_000, failure: "open" } },
    events: ["loaded", "skipped"],
    cli: [{ name: "context", summary: SUMMARY }],
  },
};

/** What the brief is built from besides the payload (a test replaces it). */
export const contextKernel = {
  /** The agent's record as the kernel prepares it (src/primitives/ops.ts `agentPreparing`), else read from the engine. */
  agent: async (runId: string, agentId: string): Promise<Pick<ScopeAgent, "contract">> => {
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

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("agent.preparing", async (call) => {
      const { agent, spec } = call.payload;
      // A fake agent (the tests' and the dry run's) reads no prompt; a profile without a context block gets no brief.
      if (!spec.provider || !spec.context?.providers?.length) return { decision: "allow" };
      const a = await contextKernel.agent(agent.runId, agent.id);
      const { roleOf } = await import("../context/brief");
      const b = await briefFor({ runId: agent.runId, agentId: agent.id, profile: agent.profile, spec, role: roleOf(a) });
      const loaded = b.providers.filter((p) => p.state === "loaded").map((p) => `${p.name} at ${sha(p.revision)}`);
      const emit = (type: string, text: string, data: Record<string, unknown>) =>
        ctx.events.emit({ type, stream: agent.runId, entity: agent.id, text, data }).catch((e: unknown) => ctx.log.warn("could not record a context event", { type, error: (e as Error)?.message ?? String(e) }));
      await emit("loaded", `${agent.id} starts with ${b.loaded} of ${b.total} context lines${loaded.length ? ` (${loaded.join(", ")})` : ""}.`, {
        agentId: agent.id, profile: agent.profile, loaded: b.loaded, total: b.total, stale: b.stale, bytes: b.bytes,
        budget: { briefBytes: b.limits.briefBytes, indexLines: b.limits.indexLines, source: b.source }, providers: b.providers,
      });
      for (const p of b.providers) if (p.state === "skipped") await emit("skipped", `${agent.id} starts without the ${p.name} context provider (${p.reason}).`, { agentId: agent.id, profile: agent.profile, provider: p.name, reason: p.reason });
      return { decision: "allow", patch: { prompt: { append: b.text } } };
    });

    ctx.cli.command({
      name: "context", summary: SUMMARY, usage: [USAGE],
      async run({ args, flags }) {
        if (args[0] !== "brief" || args.length !== 2) throw new RelayError("usage", `usage: ${USAGE}`, "Name a profile: `capcomd context brief worker`.");
        const name = args[1]!;
        const runId = typeof flags.run === "string" ? flags.run : null;
        const { resolveAgent } = await import("../profiles");
        let resolved: ReturnType<typeof resolveAgent>;
        try { resolved = resolveAgent(name); } catch (e) { throw new RelayError("usage", (e as Error).message, "See your profiles with `capcomd agents list`."); }
        const spec = resolved.spec as unknown as PinnedSpec | undefined;
        if (!spec?.context?.providers?.length) {
          return { schema: SCHEMA, ok: true, profile: name, brief: null, text: `Profile ${name} has no context block, so its agents start with no brief. Give it one in its profile: context: {providers: [{name: memory}]}` };
        }
        const b = await briefFor({ runId, agentId: null, profile: name, spec: { ...spec, ...(resolved.profile ? { profile: resolved.profile } : {}) }, role: flags.review === true ? "review" : "work" });
        return { schema: SCHEMA, ok: true, profile: name, brief: b.text, loaded: b.loaded, total: b.total, stale: b.stale, bytes: b.bytes, budget: { ...b.limits, source: b.source }, providers: b.providers, text: b.text };
      },
    });
  },
});
