import type { ModelClient } from "./models/fake";
import type { SandboxProvider } from "./providers/sandbox";
import { FakeModelClient } from "./models/fake";
import { FakeProvider } from "./providers/fake";
import { traceMethods } from "./utils/tracing-simple";
import { sandboxName } from "./providers/registry";

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

function tracedProvider(provider: SandboxProvider, name: string): SandboxProvider {
  return traceMethods("sandbox", provider, (method, args, result) => {
    const attributes: Record<string, any> = { "sandbox.provider": name, "sandbox.operation": method };
    if (typeof args[0] === "string") attributes["sandbox.vm_id"] = args[0];
    if (result && typeof result === "object" && "id" in result) attributes["sandbox.vm_id"] = result.id;
    if (method === "exec" && Array.isArray(args[1]) && args[1][0] === "git") {
      attributes["git.operation"] = args[1][1];
      if (args[1][1] === "push") attributes["git.ref"] = args[1][3];
      return { name: `git.${args[1][1]}`, attributes };
    }
    return { name: `sandbox.${method}`, attributes };
  });
}

/** The provider CAPCOMD_SANDBOX names (src/providers/registry.ts); the in-memory fake by default. */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): SandboxProvider {
  const kind = sandboxName(env);
  if (kind === "boxd") {
    const { BoxdProvider } = require("./providers/boxd") as typeof import("./providers/boxd");
    // Agents push from the VM: give git network execs a short-lived GitHub credential (env of that exec only).
    // Always on for boxd: the agent kind now comes from per-agent profiles, not CAPCOMD_AGENT, so gating on
    // agentFromEnv() left profile-driven (spawn/recipe) agents with no credential for private repos.
    const { githubGitCredentials } = require("./agents/credentials") as typeof import("./agents/credentials");
    return new BoxdProvider({ gitCredentials: githubGitCredentials() });
  }
  // Test sandbox: exec runs on this host (agent adapter e2e with a fake claude binary).
  if (kind === "fake-host") return new FakeProvider({ hostExec: true });
  return new FakeProvider(env.CAPCOMD_FAKE_ENSURE_ERROR === "auth" ? { failEnsure: "auth" } : {});
}

export function initDependencies(config?: { model?: ModelClient; provider?: SandboxProvider }) {
  const model = config?.model || new FakeModelClient();
  const provider = config?.provider || providerFromEnv();
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
}
