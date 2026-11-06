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
  provides: ["seam:sandbox/boxd"], after: ["sandbox-docker"], contributes: { seams: [{ kind: "sandbox", name: "boxd" }] },
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
  },
});

export const sandboxBoxd = { manifest, module: plugin, descriptor: DESCRIPTOR } as const;
