import type { ModelClient } from "./models/fake";
import type { SandboxProvider } from "./providers/sandbox";
import { FakeModelClient } from "./models/fake";
import { FakeProvider } from "./providers/fake";
import { traceMethods } from "./utils/tracing-simple";
import { sandboxName } from "./providers/registry";
import { resilientProvider } from "./providers/resilient";
import { hookedProvider } from "./plugins/sandbox";
import { placeInUse, sandboxProvider } from "./plugins/sandboxes";

interface Dependencies {
  model: ModelClient;
  provider: SandboxProvider;
  /** True when the sandbox is the in-memory fake: task commits are produced locally (src/merge/fakework). */
  fakeWork: boolean;
}

let deps: Dependencies | null = null;

function tracedModel(model: ModelClient, name: string): ModelClient {
  return traceMethods("model", model, (method, _args, result) => ({
    name: `model.${method}`,
    attributes: result
      ? {
          "gen_ai.system": name,
          "gen_ai.request.model": name,
          "gen_ai.usage.input_tokens": result.usage?.promptTokens,
          "gen_ai.usage.output_tokens": result.usage?.completionTokens,
          "gen_ai.response.cost": result.cost,
        }
      : { "gen_ai.system": name },
  }));
}

/** A git argv's subcommand, past global options (`git -c k=v -C dir push …`), and for a push the ref it pushes. */
export function gitSpanOf(argv: string[]): { op: string; ref?: string } {
  let i = 1;
  for (let a = argv[i]; a?.startsWith("-"); a = argv[i]) i += a === "-c" || a === "-C" ? 2 : 1;
  const op = argv[i] ?? "git";
  if (op !== "push") return { op };
  const positional = argv.slice(i + 1).filter((a) => !a.startsWith("-"));   // [remote, ref…]
  return { op, ref: positional[1] };
}

function tracedProvider(provider: SandboxProvider, name: string): SandboxProvider {
  return traceMethods("sandbox", provider, (method, args, result) => {
    const attributes: Record<string, any> = { "sandbox.provider": name, "sandbox.operation": method };
    if (typeof args[0] === "string") attributes["sandbox.vm_id"] = args[0];
    if (result && typeof result === "object" && "id" in result) attributes["sandbox.vm_id"] = result.id;
    if (method === "exec" && Array.isArray(args[1]) && args[1][0] === "git") {
      const { op, ref } = gitSpanOf(args[1] as string[]);
      attributes["git.operation"] = op;
      if (ref) attributes["git.ref"] = ref;
      return { name: `git.${op}`, attributes };
    }
    return { name: `sandbox.${method}`, attributes };
  });
}

/** The provider CAPCOMD_SANDBOX names (src/providers/registry.ts); the in-memory fake by default. */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): SandboxProvider {
  const kind = sandboxName(env);
  // Every provider rides out an outage of a few minutes (src/providers/resilient.ts).
  // The sandbox hooks (src/plugins/sandbox.ts) see every machine capcomd ensures or destroys there.
  return hookedProvider(resilientProvider(rawProviderFromEnv(env, kind), { name: kind }), kind);
}

/** The sandbox plugin's provider (src/plugins/sandboxes.ts): the kernel asks for a place by name (§7.1). */
function rawProviderFromEnv(env: Record<string, string | undefined>, kind: ReturnType<typeof sandboxName>): SandboxProvider {
  return sandboxProvider(kind, env);
}

export function initDependencies(config?: { model?: ModelClient; provider?: SandboxProvider }) {
  const model = config?.model || new FakeModelClient();
  const provider = resilientProvider(config?.provider || providerFromEnv());
  deps = {
    fakeWork: provider instanceof FakeProvider,
    model: tracedModel(model, model.constructor?.name === "FakeModelClient" ? "fake" : model.constructor?.name ?? "model"),
    provider: tracedProvider(provider, provider.constructor?.name === "FakeProvider" ? "fake" : provider.constructor?.name ?? "provider"),
  };
}

export function getDependencies(): Dependencies {
  if (!deps) initDependencies();
  return deps!;
}

export function resetDependencies() {
  deps = null;
  bySandbox.clear();
}

// Runs started on another sandbox than the daemon's (`capcomd run --sandbox`): one provider per sandbox name.
const bySandbox = new Map<string, SandboxProvider>();
/** The provider for a sandbox name; the daemon's own (getDependencies) for its CAPCOMD_SANDBOX or no name. */
export function providerNamed(name: string | null | undefined): SandboxProvider {
  if (!name || name === sandboxName()) return getDependencies().provider;
  let p = bySandbox.get(name);
  if (!p) {
    const raw = providerFromEnv({ ...process.env, CAPCOMD_SANDBOX: name, RELAY_SANDBOX: undefined });
    // A place that doesn't delete idle machines by itself (Docker, ADR-020): its plugin's timer sweeps the daemon's own
    // sandbox; this one's too.
    placeInUse(name);
    p = tracedProvider(raw, raw.constructor?.name === "FakeProvider" ? "fake" : raw.constructor?.name ?? "provider");
    bySandbox.set(name, p);
  }
  return p;
}
/** The provider a run's agents and checks use: its recorded sandbox, else the daemon's. */
export async function providerForRun(runId: string | null | undefined): Promise<{ provider: SandboxProvider; sandbox: string | null }> {
  const { runSandbox } = await import("./providers/run-sandbox");
  const sandbox = await runSandbox(runId);
  return { provider: providerNamed(sandbox), sandbox };
}
/** The provider one agent's machine is on: its profile's sandbox (`own`, ADR-024 `sandbox.provider`), else its run's. */
export async function providerForAgent(runId: string | null | undefined, own: string | null | undefined): Promise<{ provider: SandboxProvider; sandbox: string | null }> {
  return own ? { provider: providerNamed(own), sandbox: own } : providerForRun(runId);
}
