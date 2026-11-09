// sandbox-boxd (docs/spec/plugin-api.md §7.2, §17.1): boxd cloud VMs as a built-in sandbox plugin. The provider is still
// src/providers/boxd.ts BoxdProvider; what used to be the kernel's knowledge of boxd's errors (src/actors/worker.ts
// isBoxdAuthError, src/recipes/hierarchical.ts) is this plugin's classifyError (§7.2.3). The API key is the plugin's
// `apiKey` secret (§10.3): a reference, by default to BOXD_API_KEY, which the daemon's environment gets from the shell,
// the OS keychain or the credentials file `capcomd setup` wrote (src/config/store.ts applyConfig), as before.
import { definePlugin } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { ErrorClass, SandboxDescriptor } from "../../../packages/plugin/src/seams";
import { BOXD_AUTH_HINT, isBoxdAuthError, mapBoxdError } from "../../providers/boxd-errors";
import { builtinSandbox, classifySandboxError, type NativeSandbox, type SecretOf } from "../../providers/seam";
import { VERSION } from "../../utils/self";
import { contributeRows, rowContributions } from "./sandbox-rows";
import { env as envVar } from "../../utils/env";

export const DESCRIPTOR = {
  name: "boxd", descriptorVersion: 1, label: "Cloud", kind: "cloud", vendor: "boxd", title: "Cloud · boxd", mark: "boxd", listed: true,
  caps: { isolation: "vm", snapshots: true, hostBoundSecrets: true, egressAllowlist: true, interactive: true, idleLifetime: "platform", shell: true },
  settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"],
} as const satisfies SandboxDescriptor;

export const manifest = {
  schema: "capcomd.plugin/v1", name: "sandbox-boxd", version: VERSION,
  description: "boxd cloud VMs: isolated machines with snapshots, checkpoints, host-bound secrets and an egress allowlist; boxd deletes idle ones itself.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./sandbox-boxd.ts" },
  // After docker: the order clients list places in (docker, then boxd) is the load order (§6.3).
  provides: ["seam:sandbox/boxd"], after: ["sandbox-docker"], scopes: ["steer"],
  // Its details screen's settings and info rows (§4.7.5), served by GET /v1/sandboxes/boxd.
  contributes: { seams: [{ kind: "sandbox", name: "boxd" }], hooks: { "job.changed": { changes: ["fired"] } }, ui: rowContributions(DESCRIPTOR) },
  config: {
    type: "object", additionalProperties: false,
    properties: {
      apiKey: {
        type: "object", "x-secret": true, default: { $secret: "env:BOXD_API_KEY" },
        description: "The boxd API key, as a secret reference (never the value). Default: BOXD_API_KEY, which `capcomd setup` keeps in the OS keychain or the credentials file",
      },
    },
  },
} as const;

/** The project templates' refresh timer (§16.2; src/env/templates.ts refreshTemplates): one per daemon, kept across
 *  restarts by its key, daily unless CAPCOMD_TEMPLATE_REFRESH_HOURS says otherwise (0: no timer). */
export const REFRESH_LABEL = "refresh project templates";
export const refreshEveryMs = (source: Record<string, string | undefined> = process.env) => Number(envVar("TEMPLATE_REFRESH_HOURS", source) ?? 24) * 3600_000;

/** One refresh, with the daemon's boxd place and the agent CLI pins its builds use. Nothing when it has no templates. */
async function refreshIfKept(log: (l: string) => void): Promise<void> {
  const T = await import("../../env/templates");
  const source = { ...process.env, CAPCOMD_SANDBOX: "boxd" };
  if (!T.keepsProjectTemplates(source)) return;
  const { providerNamed } = await import("../../dependencies");
  const { loadAgentConfig } = await import("../../agents/config");
  await T.refreshTemplates({ provider: () => providerNamed("boxd") as any, cfg: () => loadAgentConfig({ ...process.env, CAPCOMD_CREDENTIALS: "auto", CAPCOMD_AGENT: "fake" }), source, log });
}

/** What a run that failed on a rejected key says (the reason `capcomd run` prints). */
export const BOXD_AUTH_REASON = `boxd rejected BOXD_API_KEY (invalid or expired). ${BOXD_AUTH_HINT}`;

/** boxd's errors (the SDK's classes and gRPC codes, also after they crossed an actor boundary as text), then the
 *  kernel's sandbox errors BoxdProvider maps them to. */
export function classifyBoxdError(e: unknown): ErrorClass {
  if (isBoxdAuthError(e)) return { kind: "auth", retryable: false, hint: BOXD_AUTH_REASON };
  return classifySandboxError(e instanceof PluginError ? e : mapBoxdError(e), BOXD_AUTH_REASON);
}

const native: NativeSandbox = {
  create(_env, secret?: SecretOf) {
    const { BoxdProvider } = require("../../providers/boxd") as typeof import("../../providers/boxd");
    // No git credential ever reaches a VM: the host fetches and pushes for its agents (plugin API §11.7).
    const apiKey = secret?.("apiKey");
    return new BoxdProvider({ ...(apiKey ? { apiKey } : {}) });
  },
};

export const plugin = definePlugin({
  activate(ctx) {
    ctx.seams.sandbox(builtinSandbox({
      descriptor: DESCRIPTOR,
      native,
      classifyError: classifyBoxdError,
      async available() {
        const { boxdKeyConfigured } = await import("../../api/run-options");
        return boxdKeyConfigured(process.env) ? { ok: true } : { ok: false, reason: "No boxd API key", fix: "Run `capcomd setup accounts`, or export BOXD_API_KEY." };
      },
      async instance() {
        const key = await ctx.config.secret("apiKey").catch(() => undefined);
        return native.create(process.env, () => key);
      },
    }));
    contributeRows(ctx, DESCRIPTOR);
    // The project templates' refresh: its timer fires (daily by default) and the refresh runs on its own (it fetches
    // every templated repository's mirror, longer than an observe call's deadline), starting builds in the background.
    // Its listener is registered with the refresh turned off too, as the manifest declares it (a declaration the code
    // never registers is a warning at every start, §4.7); then it refreshes nothing.
    const everyMs = refreshEveryMs();
    const log = (l: string) => ctx.log.info(l);
    ctx.hooks.on("job.changed", (call) => {
      const { job, change } = call.payload;
      if (everyMs > 0 && job.plugin === ctx.plugin.name && change.kind === "fired" && job.spec.label === REFRESH_LABEL) void refreshIfKept(log).catch(() => {});
    });
    if (!(everyMs > 0)) return;
    // Only the daemon has jobs (a CLI's plugins are refused `unsupported`).
    ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: REFRESH_LABEL, everyMs }, { key: "refresh-templates" })
      .catch((e) => { if (!(e instanceof PluginError && e.code === "unsupported")) ctx.log.warn("the project templates' refresh timer did not start", { error: String((e as Error)?.message ?? e) }); });
  },
});

export const sandboxBoxd = { manifest, module: plugin, descriptor: DESCRIPTOR } as const;
