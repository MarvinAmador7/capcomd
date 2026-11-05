// sandbox-fake and sandbox-fake-host (docs/spec/plugin-api.md §17.1): the test sandboxes as built-in plugins, never
// listed to clients (`listed: false`). `fake` keeps machines in memory and makes task commits locally (tests, `capcomd
// setup`'s demo); `fake-host` runs commands on this host (agent adapter tests with fake agent CLIs). Both are
// src/providers/fake.ts FakeProvider, with the test knobs the kernel read before: CAPCOMD_FAKE_OUTAGE_FILE (an
// injected outage, read at every call) and, for `fake`, CAPCOMD_FAKE_ENSURE_ERROR=auth (ensure fails like boxd's bad key).
import { definePlugin } from "../../../packages/plugin/src/context";
import type { ErrorClass, SandboxDescriptor } from "../../../packages/plugin/src/seams";
import { FakeProvider } from "../../providers/fake";
import { builtinSandbox, classifySandboxError, type NativeSandbox } from "../../providers/seam";
import { VERSION } from "../../utils/self";
import { BOXD_AUTH_REASON } from "./sandbox-boxd";

const hostCaps = { isolation: "host", snapshots: false, hostBoundSecrets: false, egressAllowlist: false, interactive: false, idleLifetime: "none", shell: false } as const;

export const FAKE_DESCRIPTOR = {
  name: "fake", descriptorVersion: 1, label: "Fake", kind: "local", vendor: "in-memory", title: "Fake · in-memory", mark: "fake", listed: false,
  caps: hostCaps, settings: [], info: [], resourceKinds: [], actions: [],
} as const satisfies SandboxDescriptor;

export const FAKE_HOST_DESCRIPTOR = {
  name: "fake-host", descriptorVersion: 1, label: "Fake host", kind: "local", vendor: "this host", title: "Fake host · this host", mark: "fake-host", listed: false,
  caps: hostCaps, settings: [], info: [], resourceKinds: [], actions: [],
} as const satisfies SandboxDescriptor;

/** A fake's machine that is gone (or was never made), as FakeProvider says it; the rest as every provider's. The fake
 *  stands in for boxd, so a rejected key reads like boxd's. */
export function classifyFakeError(e: unknown): ErrorClass {
  if (/\bVM \S+ not (found|ready)\b/.test(String((e as Error)?.message ?? e ?? ""))) return { kind: "not_found", retryable: false };
  return classifySandboxError(e, BOXD_AUTH_REASON);
}

const faultFile = (env: Record<string, string | undefined>) => (env.CAPCOMD_FAKE_OUTAGE_FILE ? { faultFile: env.CAPCOMD_FAKE_OUTAGE_FILE } : {});

function fakePlugin(o: { name: "sandbox-fake" | "sandbox-fake-host"; descriptor: SandboxDescriptor; description: string; native: NativeSandbox }) {
  const manifest = {
    schema: "capcomd.plugin/v1", name: o.name, version: VERSION, description: o.description,
    apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./sandbox-fake.ts" },
    provides: [`seam:sandbox/${o.descriptor.name}`], contributes: { seams: [{ kind: "sandbox", name: o.descriptor.name }] },
    config: { type: "object", additionalProperties: false, properties: {} },
  } as const;
  const plugin = definePlugin({
    activate(ctx) {
      ctx.seams.sandbox(builtinSandbox({ descriptor: o.descriptor, native: o.native, classifyError: classifyFakeError, available: async () => ({ ok: true }) }));
    },
  });
  return { manifest, plugin };
}

const fake = fakePlugin({
  name: "sandbox-fake", descriptor: FAKE_DESCRIPTOR,
  description: "The in-memory test sandbox: nothing runs, task commits are made locally (tests, the setup demo). Never shown to clients.",
  native: { create: (env) => new FakeProvider({ ...(env.CAPCOMD_FAKE_ENSURE_ERROR === "auth" ? { failEnsure: "auth" as const } : {}), ...faultFile(env) }) },
});
const fakeHost = fakePlugin({
  name: "sandbox-fake-host", descriptor: FAKE_HOST_DESCRIPTOR,
  description: "The host test sandbox: commands run on this machine (agent adapter tests with fake agent CLIs). Never shown to clients.",
  native: { create: (env) => new FakeProvider({ hostExec: true, ...faultFile(env) }) },
});

/** The in-memory fake runs no commands: the conformance suite's exec cases don't apply to it (§14.2). */
export const sandboxFake = { manifest: fake.manifest, module: fake.plugin, descriptor: FAKE_DESCRIPTOR, conformance: { exec: false } } as const;
export const sandboxFakeHost = { manifest: fakeHost.manifest, module: fakeHost.plugin, descriptor: FAKE_HOST_DESCRIPTOR } as const;
