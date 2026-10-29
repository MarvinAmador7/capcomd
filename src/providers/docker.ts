// ADR-020 §2: Docker as a sandbox provider. A sandbox is a container from the env image, kept alive by a long-running
// PID 1 (agents are started detached and polled by later execs, as on boxd), named by its idempotency key. Snapshots
// are images (`docker commit`). Docker has no host-bound secrets and no egress allowlist (see the registry), and it
// doesn't delete containers by itself: each has a delete-after time, kept in a ledger next to capcomd's state, and
// `sweep()` removes the expired ones (the engine runs it).
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { SnapshotInfo } from "../env/platform";
import type { InteractiveSession } from "../auth/interactive";
import { stateDir } from "../utils/home";
import { noGitCredentials, type GitCredentialHook } from "./boxd";
import { SandboxConfigError, SandboxError, SandboxNotFoundError, SandboxTimeoutError } from "./boxd-errors";
import { reportMachineDeleted } from "./machine-audit";
import { MACHINE_PREFIX, type ExecResult, type SandboxProvider, type VmId, type VmInfo, type VmSpec } from "./sandbox";

/** The default base image: Debian with node, git, curl, coreutils (`timeout`) and util-linux (`setsid`, `script`). */
export const DOCKER_BASE_IMAGE = "node:22-bookworm";
export const DOCKER_LABEL = "dev.capcomd.sandbox";
const LABEL = DOCKER_LABEL;

export interface DockerProviderOptions {
  /** The docker CLI (default: CAPCOMD_DOCKER_BIN, `docker` on PATH, or OrbStack's). */
  bin?: string;
  /** Image a sandbox starts from when its spec names no snapshot (default CAPCOMD_DOCKER_IMAGE or DOCKER_BASE_IMAGE). */
  image?: string;
  gitCredentials?: GitCredentialHook;
  /** Container name prefix; `list(prefix)` filters on it. */
  namePrefix?: string;
  /** Delete-after times by container (default <state>/docker-ttl.json). */
  ledgerPath?: string;
}

/** The docker CLI to use: CAPCOMD_DOCKER_BIN, else `docker` on PATH, else OrbStack's or Docker Desktop's. */
export function dockerBin(source: Record<string, string | undefined> = process.env): string {
  if (source.CAPCOMD_DOCKER_BIN) return source.CAPCOMD_DOCKER_BIN;
  for (const dir of (source.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "docker"))) return join(dir, "docker");
  for (const p of [join(homedir(), ".orbstack/bin/docker"), "/usr/local/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]) if (existsSync(p)) return p;
  return "docker";
}

const nameFor = (idemKey: string, prefix: string) => `${prefix}${createHash("sha256").update(idemKey).digest("hex").slice(0, 16)}`;

interface Run { code: number; stdout: Uint8Array; stderr: string }

export class DockerProvider implements SandboxProvider {
  private readonly bin: string;
  private readonly image: string;
  private readonly gitCredentials: GitCredentialHook;
  private readonly prefix: string;
  private readonly ledgerPath: string;
  private readonly labels = new Map<VmId, Record<string, string>>();

  constructor(o: DockerProviderOptions = {}) {
    this.bin = o.bin ?? dockerBin();
    this.image = o.image ?? process.env.CAPCOMD_DOCKER_IMAGE ?? DOCKER_BASE_IMAGE;
    this.gitCredentials = o.gitCredentials ?? noGitCredentials;
    this.prefix = o.namePrefix ?? MACHINE_PREFIX;
    this.ledgerPath = o.ledgerPath ?? process.env.CAPCOMD_DOCKER_LEDGER ?? join(stateDir(), "docker-ttl.json");
  }

  /** Runs the docker CLI. `env` is the client's environment: exec passes values to the container from it (`-e NAME`),
   *  so no value is ever on a command line. */
  private async docker(args: string[], o: { input?: Uint8Array; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Run> {
    let p;
    try {
      p = Bun.spawn([this.bin, ...args], { stdin: o.input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(o.env ?? {}) } });
    } catch (e) {
      throw new SandboxConfigError(`can't run ${this.bin}: ${(e as Error).message}. Install Docker (or OrbStack), or set CAPCOMD_DOCKER_BIN.`);
    }
    if (o.input) { p.stdin!.write(o.input); await p.stdin!.end(); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = o.timeoutMs ? new Promise<"timeout">((r) => { timer = setTimeout(() => { p.kill("SIGKILL"); r("timeout"); }, o.timeoutMs); }) : null;
    const done = Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
    const r = timedOut ? await Promise.race([done, timedOut]) : await done;
    if (timer) clearTimeout(timer);
    if (r === "timeout") return { code: 124, stdout: new Uint8Array(), stderr: `docker ${args[0]} timed out after ${o.timeoutMs}ms` };
    return { code: r[2], stdout: new Uint8Array(r[0]), stderr: r[1] };
  }
  private async must(args: string[], what: string, o: Parameters<DockerProvider["docker"]>[1] = {}): Promise<string> {
    const r = await this.docker(args, o);
    if (r.code !== 0) throw this.err(r.stderr, what, args[args.length - 1]);
    return new TextDecoder().decode(r.stdout).trim();
  }
  private err(stderr: string, what: string, id?: string): SandboxError {
    const msg = `docker ${what}: ${stderr.trim().slice(-500)}`;
    if (/No such container|No such object|is not running/i.test(stderr)) return new SandboxNotFoundError(msg, id);
    if (/Cannot connect to the Docker daemon|docker daemon|error during connect/i.test(stderr)) return new SandboxConfigError(`${msg}. Start Docker (or OrbStack) and retry.`);
    return new SandboxError(msg, id);
  }

  private ledger(): Record<string, number> {
    try { return JSON.parse(readFileSync(this.ledgerPath, "utf8")); } catch { return {}; }
  }
  private setDeleteAfter(name: string, at: number | null) {
    const l = this.ledger();
    if (at === null) delete l[name]; else l[name] = at;
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const tmp = `${this.ledgerPath}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(l));
    renameSync(tmp, this.ledgerPath);
  }

  async ensure(spec: VmSpec): Promise<{ id: VmId; created: boolean }> {
    const name = nameFor(spec.idemKey, this.prefix);
    this.labels.set(name, spec.labels);
    const state = await this.docker(["inspect", "-f", "{{.State.Status}}", name]);
    if (state.code === 0) {
      if (new TextDecoder().decode(state.stdout).trim() !== "running") await this.must(["start", name], "start");
      return { id: name, created: false };
    }
    // Docker has no egress allowlist (ADR-020): the container gets Docker's network. An empty list is still refused.
    if (!spec.egressAllow?.length) throw new SandboxConfigError("refusing to create a sandbox with an empty egress list (\"*\" means unrestricted)");
    const labels = Object.entries({ ...spec.labels, [LABEL]: "1", "dev.capcomd.idem": spec.idemKey }).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    // A snapshot is named as capcomd names it (capcomd-env-…); a full image reference works too.
    const image = spec.fromSnapshot ? (/[:/@]/.test(spec.fromSnapshot) ? spec.fromSnapshot : imageRef(spec.fromSnapshot)) : this.image;
    // --init reaps the detached agent processes; `sleep infinity` keeps the sandbox up between execs.
    const r = await this.docker(["run", "-d", "--init", "--name", name, "--hostname", name, ...labels, image, "sleep", "infinity"], { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) {
      if (/already in use/i.test(r.stderr)) return { id: name, created: false }; // a concurrent ensure won
      throw this.err(r.stderr, "run");
    }
    this.setDeleteAfter(name, Date.now() + spec.ttlSeconds * 1000);
    return { id: name, created: true };
  }

  async waitReady(id: VmId, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.docker(["exec", id, "true"]);
      if (r.code === 0) return;
      if (/No such container/i.test(r.stderr)) throw this.err(r.stderr, "exec", id);
      if (Date.now() > until) throw new SandboxTimeoutError(`container ${id} not ready within ${timeoutMs}ms`, id);
      await Bun.sleep(250);
    }
  }

  async exec(id: VmId, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string }): Promise<ExecResult> {
    let env = opts?.env ?? {};
    if (cmd[0] === "git") {
      const creds = await this.gitCredentials({ vmId: id, labels: this.labels.get(id) ?? {}, cmd });
      if (creds) env = { ...env, ...creds };
    }
    // The timeout runs in the container too, so the command itself is killed, not only this client.
    const timed = opts?.timeoutMs ? ["timeout", "-k", "5", String(Math.max(1, Math.ceil(opts.timeoutMs / 1000))), ...cmd] : cmd;
    const args = ["exec", ...(opts?.cwd ? ["-w", opts.cwd] : []), ...Object.keys(env).flatMap((k) => ["-e", k]), id, ...timed];
    const r = await this.docker(args, { env, ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs + 15_000 } : {}) });
    if (r.code !== 0 && /No such container|is not running/i.test(r.stderr) && r.stdout.length === 0) throw this.err(r.stderr, "exec", id);
    return { code: r.code, stdout: new TextDecoder().decode(r.stdout), stderr: r.stderr };
  }

  async upload(id: VmId, path: string, data: Uint8Array): Promise<void> {
    const r = await this.docker(["exec", "-i", id, "sh", "-c", 'cat > "$1"', "sh", path], { input: data });
    if (r.code !== 0) throw this.err(r.stderr, `upload ${path}`, id);
  }

  async download(id: VmId, path: string): Promise<Uint8Array> {
    const r = await this.docker(["exec", id, "cat", path]);
    if (r.code !== 0) throw this.err(r.stderr, `download ${path}`, id);
    return r.stdout;
  }

  /** No egress allowlist on Docker (ADR-020); profiles that restrict egress are refused before a spawn. */
  async setEgress(): Promise<void> {}
  async checkpoint(): Promise<void> { throw new SandboxConfigError("docker sandboxes have no checkpoints (use snapshots)"); }
  async restore(): Promise<void> { throw new SandboxConfigError("docker sandboxes have no checkpoints (use snapshots)"); }
  async snapshot(id: VmId, name: string): Promise<void> { await this.snapshotCreate(id, name); }
  async suspend(id: VmId): Promise<void> { await this.must(["pause", id], "pause"); }
  async resume(id: VmId): Promise<void> { await this.must(["unpause", id], "unpause"); }

  async destroy(id: VmId): Promise<void> {
    const r = await this.docker(["rm", "-f", id]);
    if (r.code !== 0 && !/No such container/i.test(r.stderr)) throw this.err(r.stderr, "rm", id);
    this.setDeleteAfter(id, null);
    this.labels.delete(id);
  }

  async list(prefix: string): Promise<VmInfo[]> {
    const out = await this.must(["ps", "-a", "--filter", `label=${LABEL}=1`, "--format", "{{.Names}}\t{{.State}}\t{{.CreatedAt}}"], "ps");
    const l = this.ledger();
    return out.split("\n").filter(Boolean).map((line) => {
      const [name, state, created] = line.split("\t");
      const at = l[name!];
      return { id: name!, name: name!, state: state ?? "unknown", createdAt: dockerTime(created), deleteAt: typeof at === "number" ? at : null };
    }).filter((v) => v.name.startsWith(prefix));
  }

  async extendTtl(id: VmId, seconds: number): Promise<void> {
    this.setDeleteAfter(id, Date.now() + seconds * 1000);
  }

  /** Removes capcomd's containers whose delete-after time has passed (the TTL boxd enforces itself), and returns the
   *  names of the ones it removed (one it couldn't remove is tried again next time). */
  async sweep(now = Date.now()): Promise<string[]> {
    const l = this.ledger();
    const gone: string[] = [];
    for (const v of await this.list(this.prefix)) {
      const at = l[v.name];
      if (at !== undefined && at < now && await this.destroy(v.id).then(() => true, () => false)) gone.push(v.name);
    }
    return gone;
  }

  // Snapshots are images (EnvPlatform's snapshot half).
  async snapshotCreate(id: VmId, name: string): Promise<SnapshotInfo> {
    const ref = await this.must(["commit", id, imageRef(name)], "commit");
    return { name, status: "ready", id: ref };
  }
  async snapshotGet(name: string): Promise<SnapshotInfo | null> {
    const r = await this.docker(["image", "inspect", "-f", "{{.Id}}\t{{.Created}}", imageRef(name)]);
    if (r.code !== 0) return null;
    const [id, createdAt] = new TextDecoder().decode(r.stdout).trim().split("\t");
    return { name, status: "ready", ...(id ? { id } : {}), ...(createdAt ? { createdAt } : {}) };
  }
  async snapshotList(): Promise<SnapshotInfo[]> {
    const out = await this.must(["image", "ls", "--filter", "reference=capcomd-*", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}"], "image ls");
    return out.split("\n").filter(Boolean).map((l) => { const [ref, id, createdAt] = l.split("\t"); return { name: fromImageRef(ref!), status: "ready" as const, ...(id ? { id } : {}), ...(createdAt ? { createdAt } : {}) }; });
  }
  async snapshotDelete(name: string): Promise<void> {
    const r = await this.docker(["image", "rm", "-f", imageRef(name)]);
    if (r.code !== 0 && !/No such image/i.test(r.stderr)) throw this.err(r.stderr, "image rm");
  }

  /**
   * A command with a terminal (interactive logins): `script` gives it a pseudo-terminal inside the container, and
   * its input and output go through `docker exec -i`, so this host needs no terminal of its own.
   */
  streamExec(id: VmId, cmd: string[], opts: { env?: Record<string, string>; tty?: boolean; cols?: number; rows?: number } = {}): InteractiveSession {
    const env = opts.env ?? {};
    const line = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const sized = `stty cols ${opts.cols ?? 100} rows ${opts.rows ?? 30} 2>/dev/null; exec ${line}`;
    const args = ["exec", "-i", ...Object.keys(env).flatMap((k) => ["-e", k]), id, ...(opts.tty === false ? ["sh", "-c", line] : ["script", "-qfec", sized, "/dev/null"])];
    const p = Bun.spawn([this.bin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    async function* output() {
      const merge = async function* (s: ReadableStream<Uint8Array>) { for await (const c of s as any) yield c as Uint8Array; };
      // stdout carries the terminal; stderr only docker's own errors.
      yield* merge(p.stdout as ReadableStream<Uint8Array>);
      for await (const c of merge(p.stderr as ReadableStream<Uint8Array>)) yield c;
    }
    return {
      write: (d) => { p.stdin!.write(typeof d === "string" ? new TextEncoder().encode(d) : d); p.stdin!.flush?.(); },
      end: () => { void p.stdin!.end(); },
      close: () => { p.kill(); },
      output: output(),
      wait: () => p.exited,
    };
  }
}

/** `docker ps` {{.CreatedAt}} ("2026-10-27 09:12:03 +0000 UTC") as ms epoch; null when it isn't that shape. */
export function dockerTime(s: string | undefined): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-])(\d{2})(\d{2})/.exec(s?.trim() ?? "");
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isFinite(t) ? t : null;
}

/** Snapshot names (`capcomd-env-<hash>`, `capcomd-auth-<agent>-<hash>`) as image references. */
export const imageRef = (name: string) => `${name.toLowerCase()}:capcomd`;
const fromImageRef = (ref: string) => ref.replace(/:capcomd$/, "");

/** The engine's sweep (`capcomd serve`, every 5 minutes): removes capcomd's expired containers and audits each one as
 *  deleted after its idle lifetime (sandbox.resource_deleted, cause idle_lifetime). Returns their names. */
export async function sweepIdle(p: Pick<DockerProvider, "sweep">, now = Date.now()): Promise<string[]> {
  const gone = await p.sweep(now);
  for (const name of gone) reportMachineDeleted("docker", name, "idle_lifetime");
  return gone;
}
