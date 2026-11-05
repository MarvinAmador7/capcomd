// Worked example, spec §15.1: the Docker sandbox provider as a built-in, in-process plugin. Today's
// src/providers/docker.ts DockerProvider becomes this module; src/providers/registry.ts's descriptor moves into
// `describe()`; the 5-minute sweep src/cli/commands/serve.ts starts moves into the `daemon.started` listener.
import { definePlugin, PluginError, type ErrorClass, type ExecResult, type MachineInfo, type SandboxDescriptor, type SandboxProvider, type SeamCall, type VmSpec } from "../../src/index";

interface Config { bin: string; image: string; agentMemoryMb: 512 | 1024 | 2048 | 4096; idleLifetimeSeconds: number }

const DESCRIPTOR: SandboxDescriptor = {
  name: "docker", descriptorVersion: 1, label: "Local", kind: "local", vendor: "Docker", title: "Local · Docker", mark: "docker", listed: true,
  caps: { isolation: "container", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true, idleLifetime: "sweep", shell: true },
  settings: ["idleLifetime", "agentMemory"], info: ["logins", "checkpoints", "agentSlots"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"],
};

/** Run the docker CLI; the SeamCall's signal kills it. A non-zero exit is returned, not thrown. */
async function docker(bin: string, args: string[], c: SeamCall, stdin?: Uint8Array): Promise<ExecResult> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: stdin ?? "ignore" });
  const onAbort = () => proc.kill("SIGKILL");
  c.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (c.signal.aborted) throw new PluginError("timeout", `docker ${args[0]} did not finish by ${c.deadline}`);
    return { code, stdout, stderr };
  } finally { c.signal.removeEventListener("abort", onAbort); }
}

class DockerProvider implements SandboxProvider {
  constructor(private readonly cfg: Config, private readonly ledger: { deadlines: Map<string, number> }) {}
  describe(): SandboxDescriptor { return DESCRIPTOR; }
  async available(c: SeamCall) {
    const r = await docker(this.cfg.bin, ["version", "--format", "{{.Server.Version}}"], c);
    return r.code === 0 ? { ok: true as const } : { ok: false as const, reason: "Docker isn't running", fix: "Start Docker Desktop (or OrbStack, Colima), then retry." };
  }
  classifyError(e: unknown): ErrorClass {
    const m = e instanceof Error ? e.message : String(e);
    if (/No such container|not found/i.test(m)) return { kind: "not_found", retryable: false };
    if (/Cannot connect to the Docker daemon|connection refused/i.test(m)) return { kind: "transient", retryable: true, retryAfterMs: 5_000 };
    if (/permission denied/i.test(m)) return { kind: "config", retryable: false, hint: "Add your user to the docker group, or run Docker Desktop." };
    return { kind: "unknown", retryable: false };
  }
  async ensure(spec: VmSpec, c: SeamCall) {
    const name = `relay-${spec.idemKey}`;
    const existing = await docker(this.cfg.bin, ["ps", "-aq", "--filter", `name=^${name}$`], c);
    if (existing.stdout.trim()) return { id: name, created: false };
    const labels = Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    const image = spec.fromSnapshot ?? this.cfg.image;
    const r = await docker(this.cfg.bin, ["run", "-d", "--name", name, "--memory", `${this.cfg.agentMemoryMb}m`, ...labels, image, "sleep", "infinity"], c);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `docker run exited ${r.code}`);
    this.ledger.deadlines.set(name, Date.now() + spec.ttlSeconds * 1000);
    return { id: name, created: true };
  }
  async waitReady(id: string, c: SeamCall) {
    while (!c.signal.aborted) {
      const r = await docker(this.cfg.bin, ["inspect", "-f", "{{.State.Running}}", id], c);
      if (r.code !== 0) throw new PluginError("not_found", `container ${id} is gone`);
      if (r.stdout.trim() === "true") return;
      await Bun.sleep(250);
    }
    throw new PluginError("timeout", `container ${id} did not start by ${c.deadline}`);
  }
  async exec(id: string, cmd: string[], opts: { env?: Record<string, string>; cwd?: string }, c: SeamCall) {
    const env = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const cwd = opts.cwd ? ["-w", opts.cwd] : [];
    const r = await docker(this.cfg.bin, ["exec", ...env, ...cwd, id, ...cmd], c);
    if (r.code === 125 && /No such container/i.test(r.stderr)) throw new PluginError("not_found", `container ${id} is gone`);
    return r;
  }
  async upload(id: string, path: string, data: Uint8Array, c: SeamCall) { await docker(this.cfg.bin, ["cp", "-", `${id}:${path}`], c, data); }
  async download(id: string, path: string, c: SeamCall) { return new TextEncoder().encode((await docker(this.cfg.bin, ["exec", id, "cat", path], c)).stdout); }
  async setEgress(): Promise<void> { throw new PluginError("unsupported", "Docker can't enforce an egress allowlist (caps.egressAllowlist is false)"); }
  async snapshot(id: string, name: string, c: SeamCall) { await docker(this.cfg.bin, ["commit", id, `capcomd/env:${name}`], c); }
  async checkpoint(): Promise<void> { throw new PluginError("unsupported", "checkpoints are git-based on Docker (ADR-019 §3)"); }
  async restore(): Promise<void> { throw new PluginError("unsupported", "checkpoints are git-based on Docker (ADR-019 §3)"); }
  async suspend(id: string, c: SeamCall) { await docker(this.cfg.bin, ["pause", id], c); }
  async resume(id: string, c: SeamCall) { await docker(this.cfg.bin, ["unpause", id], c); }
  async destroy(id: string, c: SeamCall) { await docker(this.cfg.bin, ["rm", "-f", id], c); this.ledger.deadlines.delete(id); }
  async list(prefix: string, c: SeamCall): Promise<MachineInfo[]> {
    const r = await docker(this.cfg.bin, ["ps", "-a", "--filter", `name=^${prefix}`, "--format", "{{.ID}}\t{{.Names}}\t{{.State}}"], c);
    return r.stdout.split("\n").filter(Boolean).map((l) => { const [id = "", name = "", state = ""] = l.split("\t"); return { id, name, state, deleteAt: this.ledger.deadlines.get(name) ?? null }; });
  }
  async extendTtl(id: string, seconds: number) { this.ledger.deadlines.set(id, Date.now() + seconds * 1000); }
  async probe(_id: string | undefined, c: SeamCall) { const r = await docker(this.cfg.bin, ["version"], c); if (r.code !== 0) throw new Error("docker did not answer"); }
  async sweep(c: SeamCall) {
    const deleted: string[] = [];
    for (const [id, at] of this.ledger.deadlines) if (at < Date.now()) { await this.destroy(id, c); deleted.push(id); }
    return { deleted };
  }
}

export const plugin = definePlugin<Config>({
  activate(ctx) {
    const provider = new DockerProvider(ctx.config.get(), { deadlines: new Map() });
    ctx.seams.sandbox(provider);
    // The idle-machine sweep (caps.idleLifetime "sweep") runs once the daemon is up; the host calls `sweep` through
    // the resilient wrapper, so this listener only schedules it. The interval dies with the plugin.
    ctx.hooks.on("daemon.started", () => {
      const every = setInterval(() => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 60_000);
        provider.sweep({ signal: ac.signal, deadline: new Date(Date.now() + 60_000).toISOString(), trace: { traceId: "", spanId: "" } })
          .then((r) => { if (r.deleted.length) ctx.log.info("swept idle containers", { deleted: r.deleted.length }); })
          .catch((e) => ctx.log.warn("sweep failed", { error: String(e) }))
          .finally(() => clearTimeout(t));
      }, 5 * 60_000);
      ctx.onDispose(() => clearInterval(every));
    });
    ctx.ui.descriptor({
      kind: "settings", id: "agentMemory", label: "Memory per agent", help: "Sets how many agents run at once.", type: "choice",
      choices: [512, 1024, 2048, 4096].map((v) => ({ value: String(v), label: `${v / 1024 >= 1 ? v / 1024 + " GB" : v + " MB"}` })),
      async read() { return { value: String(ctx.config.get().agentMemoryMb), display: `${ctx.config.get().agentMemoryMb} MB`, source: "config", editable: true }; },
    });
  },
});
