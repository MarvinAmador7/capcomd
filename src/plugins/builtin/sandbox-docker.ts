// sandbox-docker (docs/spec/plugin-api.md §15.1, §17.1): containers on this machine's Docker as a built-in sandbox
// plugin. The provider is still src/providers/docker.ts DockerProvider (the kernel's consumers call it as they always
// have, through the seam's NATIVE factory); its descriptor is the seam's `describe()`, the docker CLI probe is
// `available()`, and its errors are classified here instead of in the kernel. The idle-container sweep is the seam's
// `sweep`, run on this plugin's own timer (§16.2: a plugin-owned job, re-armed by the daemon after a restart) when the
// daemon starts and every 5 minutes, while Docker is the place in use (src/plugins/sandboxes.ts sweepPlace).
import { definePlugin } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
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
  provides: ["seam:sandbox/docker"], scopes: ["steer"],
  contributes: { seams: [{ kind: "sandbox", name: "docker" }], hooks: { "job.changed": { changes: ["fired"] } } },
  config: { type: "object", additionalProperties: false, properties: {} },
} as const;

/** The sweep's timer (§16.2): one per daemon, kept across restarts by its key. */
export const SWEEP_EVERY_MS = 5 * 60_000;
export const SWEEP_TIMER = { kind: "timer", runId: null, owner: { plugin: true }, label: "sweep idle containers", everyMs: SWEEP_EVERY_MS } as const;

/** One round of the sweep, while Docker is a place in use (the daemon's, or a run's). */
async function sweepIfInUse(): Promise<void> {
  const S = await import("../sandboxes");
  if (S.inUse(DESCRIPTOR.name)) await S.sweepPlace(DESCRIPTOR.name);
}

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
    // No git credential ever reaches a container: the host fetches and pushes for its agents (plugin API §11.7).
    return new DockerProvider();
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
    // Its timer fires every 5 minutes; a sweep may take longer than an observe call's deadline, so it runs on its own.
    ctx.hooks.on("job.changed", (call) => {
      const { job, change } = call.payload;
      if (job.plugin === ctx.plugin.name && change.kind === "fired" && job.spec.label === SWEEP_TIMER.label) void sweepIfInUse().catch(() => {});
    });
    // Only the daemon has jobs (a CLI's plugins are refused `unsupported`): it sweeps now, then on the timer.
    ctx.jobs.start({ ...SWEEP_TIMER, owner: { plugin: true } }, { key: "sweep" })
      .then(() => sweepIfInUse(), (e) => { if (!(e instanceof PluginError && e.code === "unsupported")) ctx.log.warn("the idle-container sweep's timer did not start", { error: String((e as Error)?.message ?? e) }); })
      .catch(() => {});
  },
});

export const sandboxDocker = { manifest, module: plugin, descriptor: DESCRIPTOR } as const;
