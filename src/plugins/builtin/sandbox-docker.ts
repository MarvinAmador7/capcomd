// sandbox-docker (docs/spec/plugin-api.md §15.1, §17.1): containers on this machine's Docker as a built-in sandbox
// plugin. The provider is still src/providers/docker.ts DockerProvider (the kernel's consumers call it as they always
// have, through the seam's NATIVE factory); its descriptor is the seam's `describe()`, the docker CLI probe is
// `available()`, and its errors are classified here instead of in the kernel. The idle-container sweep is the seam's
// `sweep`, which the kernel calls every 5 minutes for a place in use (src/plugins/sandboxes.ts keepTidy).
import { definePlugin } from "../../../packages/plugin/src/context";
import type { ErrorClass, SandboxDescriptor } from "../../../packages/plugin/src/seams";
import { builtinSandbox, classifySandboxError, type NativeSandbox } from "../../providers/seam";
import type { DockerProvider } from "../../providers/docker";
import { VERSION } from "../../utils/self";

export const DESCRIPTOR = {
  name: "docker", descriptorVersion: 1, label: "Local", kind: "local", vendor: "Docker", title: "Local · Docker", mark: "docker", listed: true,
  caps: { isolation: "container", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true, idleLifetime: "sweep", shell: true },
  // agentMemory: how much of Docker's memory each agent gets; agentSlots: so how many run at once
  // (src/providers/capacity.ts).
  settings: ["idleLifetime", "agentMemory"], info: ["logins", "checkpoints", "agentSlots"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"],
} as const satisfies SandboxDescriptor;

export const manifest = {
  schema: "capcomd.plugin/v1", name: "sandbox-docker", version: VERSION,
  description: "Containers on this machine's Docker (Docker Desktop, OrbStack, Colima, Podman's docker). Snapshots are images; idle containers are swept by capcomd.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./sandbox-docker.ts" },
  provides: ["seam:sandbox/docker"], contributes: { seams: [{ kind: "sandbox", name: "docker" }] },
  config: { type: "object", additionalProperties: false, properties: {} },
} as const;

/** Docker's daemon isn't answering, as the docker CLI says it. */
const DAEMON_DOWN = /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect/i;

export function classifyDockerError(e: unknown): ErrorClass {
  const m = String((e as Error)?.message ?? e ?? "");
  if (/permission denied.*docker\.sock|docker\.sock.*permission denied/i.test(m)) return { kind: "config", retryable: false, hint: "This user can't use Docker's socket: add it to the docker group, or run Docker Desktop (or OrbStack)." };
  if (/No such container/i.test(m)) return { kind: "not_found", retryable: false };
  // Docker has no credential of capcomd's to reject: a socket it may not use is `config` (above).
  const c = classifySandboxError(e, null);
  if (c.kind === "unknown" && DAEMON_DOWN.test(m)) return { kind: "transient", retryable: true, retryAfterMs: 5_000 };
  return c;
}

const native: NativeSandbox = {
  create() {
    const { DockerProvider } = require("../../providers/docker") as typeof import("../../providers/docker");
    // Agents push from the container: git network execs get a short-lived GitHub credential (env of that exec only).
    const { githubGitCredentials } = require("../../agents/credentials") as typeof import("../../agents/credentials");
    return new DockerProvider({ gitCredentials: githubGitCredentials() });
  },
};

export const plugin = definePlugin({
  activate(ctx) {
    ctx.seams.sandbox(builtinSandbox({
      descriptor: DESCRIPTOR,
      native,
      classifyError: classifyDockerError,
      async available() {
        const { dockerReachable } = await import("../../api/run-options");
        const d = await dockerReachable(process.env);
        return d.ok ? { ok: true } : { ok: false, reason: d.reason ?? "Docker isn't running", fix: "Start Docker Desktop (or OrbStack, Colima), then retry." };
      },
      async sweep(p) {
        const { sweepIdle } = await import("../../providers/docker");
        return sweepIdle(p as DockerProvider);
      },
    }));
  },
});

export const sandboxDocker = { manifest, module: plugin, descriptor: DESCRIPTOR } as const;
