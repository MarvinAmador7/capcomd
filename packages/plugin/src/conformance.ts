// The sandbox seam conformance suite (spec §14.2, §7.2): what every sandbox plugin must do, as cases a runner can
// report one by one. `testkit.conformance.sandbox` registers them as bun tests; `capcomd plugins validate
// --conformance` runs them and prints each result. Every machine a case makes is destroyed at the end.
import { PluginError } from "./errors";
import type { SandboxProvider, SeamCall } from "./seams";
import type { VmSpec } from "./shapes";

export interface SandboxConformanceOptions {
  /** The seam's declared name: `describe().name` must equal it. */
  name?: string;
  /** Run the cases that need commands to really run (exit codes, env, cwd, a deadline that kills). Default true; false
   *  only for an in-memory fake. */
  exec?: boolean;
  /** The machine name prefix `list` filters on (the kernel's MACHINE_PREFIX). Idempotency keys start with it too. */
  prefix?: string;
  /** An absolute directory inside a machine that files may be written to. Default `/tmp`. */
  scratch?: string;
  /** How long a machine may take to become ready. Default 120 s. */
  readyMs?: number;
  /** Reserved: no case makes snapshots yet (a snapshot outlives the suite's machines). */
  skipSnapshots?: boolean;
}

export interface ConformanceResult { name: string; ok: boolean; skipped: boolean; ms: number; message: string | null }

type Options = Required<Omit<SandboxConformanceOptions, "name" | "skipSnapshots">> & { name: string | null };
interface Run { p: SandboxProvider; o: Options; made: Set<string>; tag: string; key(k: string): string; spec(k: string): VmSpec; call(ms?: number): SeamCall; box(k: string): Promise<string> }
interface Case { name: string; exec?: true; run(r: Run): Promise<void> }

const fail = (message: string): never => { throw new Error(message); };
const equal = (a: unknown, b: unknown, what: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
async function rejection(p: Promise<unknown>, what: string): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  return fail(`${what} resolved; it must reject`);
}
const isTimeout = (r: Run, e: unknown) => (e instanceof PluginError && e.code === "timeout") || r.p.classifyError(e).kind === "timeout";

/** A SeamCall `ms` ahead, its signal aborted at the deadline. */
export function conformanceCall(ms = 60_000): SeamCall {
  return { signal: AbortSignal.timeout(ms), deadline: new Date(Date.now() + ms).toISOString(), trace: { traceId: "0".repeat(32), spanId: "0".repeat(16) } };
}

export const SANDBOX_CASES: readonly Case[] = [
  { name: "describe: descriptor version 1, the seam's name, the same each time", async run(r) {
    const d = r.p.describe();
    equal(d.descriptorVersion, 1, "descriptorVersion");
    if (r.o.name !== null) equal(d.name, r.o.name, "describe().name");
    equal(r.p.describe(), d, "a second describe()");
  } },
  { name: "available never rejects", async run(r) {
    const a = await r.p.available(r.call());
    if (typeof a?.ok !== "boolean") fail(`available() answered ${JSON.stringify(a)}`);
    if (!a.ok && (typeof a.reason !== "string" || !a.reason)) fail("available() said no without a reason");
  } },
  { name: "classifyError: a refused connection is transient; it never throws", async run(r) {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const c = r.p.classifyError(refused);
    if (c.kind !== "transient" || !c.retryable) fail(`a refused connection classified as ${JSON.stringify(c)}`);
    for (const odd of [undefined, null, "a string", 42, {}, new Error("something else entirely")]) {
      const x = r.p.classifyError(odd);
      if (typeof x?.kind !== "string") fail(`classifyError(${JSON.stringify(odd)}) answered ${JSON.stringify(x)}`);
    }
  } },
  { name: "ensure is idempotent by idemKey; list finds it by prefix; destroy is idempotent; a destroyed machine is not_found", async run(r) {
    const spec = r.spec("idem");
    const a = await r.p.ensure(spec, r.call());
    r.made.add(a.id);
    equal(a.created, true, "the first ensure's created");
    equal(await r.p.ensure(spec, r.call()), { id: a.id, created: false }, "a second ensure with the same idemKey");
    await r.p.waitReady(a.id, r.call(r.o.readyMs));
    if (!(await r.p.list(r.o.prefix, r.call())).some((m) => m.id === a.id)) fail(`list(${JSON.stringify(r.o.prefix)}) doesn't include ${a.id}`);
    await r.p.destroy(a.id, r.call());
    await r.p.destroy(a.id, r.call());
    if ((await r.p.list(r.o.prefix, r.call())).some((m) => m.id === a.id)) fail(`list still includes ${a.id} after destroy`);
    const e = await rejection(r.p.exec(a.id, ["true"], {}, r.call()), "exec on a destroyed machine");
    const c = r.p.classifyError(e);
    if (!(e instanceof PluginError && e.code === "not_found") && c.kind !== "not_found") fail(`exec on a destroyed machine rejected ${String((e as Error)?.message ?? e)}, classified ${JSON.stringify(c)}`);
  } },
  { name: "upload and download round-trip bytes", async run(r) {
    const id = await r.box("files");
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const path = `${r.o.scratch}/capcomd-conformance-${r.tag}.bin`;
    await r.p.upload(id, path, bytes, r.call());
    const back = await r.p.download(id, path, r.call());
    // A machine that shares this host's files (a test fake) would keep it: remove it where commands run.
    if (r.o.exec) await r.p.exec(id, ["rm", "-f", path], {}, r.call()).catch(() => {});
    if (back.length !== bytes.length || back.some((b, i) => b !== bytes[i])) fail(`download returned ${back.length} bytes, not the ${bytes.length} uploaded`);
  } },
  { name: "exec: argv, exit code, stdout and stderr, env, cwd", exec: true, async run(r) {
    const id = await r.box("exec");
    equal(await r.p.exec(id, ["sh", "-c", "echo out; echo err >&2; exit 3"], {}, r.call()), { code: 3, stdout: "out\n", stderr: "err\n" }, "exec of a failing command");
    equal((await r.p.exec(id, ["printenv", "CONFORMANCE"], { env: { CONFORMANCE: "a b'c" } }, r.call())).stdout, "a b'c\n", "an env value");
    equal((await r.p.exec(id, ["pwd"], { cwd: "/" }, r.call())).stdout, "/\n", "cwd");
  } },
  { name: "a deadline or an abort during exec rejects timeout within 5 s", exec: true, async run(r) {
    const id = await r.box("deadline");
    let t0 = Date.now();
    // 10 s commands: an implementation that waits for the command instead of the deadline takes twice the limit.
    const late = await rejection(r.p.exec(id, ["sleep", "10"], {}, r.call(1000)), "an exec past its deadline");
    if (!isTimeout(r, late)) fail(`an exec past its deadline rejected ${String((late as Error)?.message ?? late)}, not timeout`);
    if (Date.now() - t0 > 5000) fail(`an exec past a 1 s deadline took ${Date.now() - t0} ms to settle`);
    const ac = new AbortController();
    const c: SeamCall = { signal: ac.signal, deadline: new Date(Date.now() + 60_000).toISOString(), trace: { traceId: "0".repeat(32), spanId: "0".repeat(16) } };
    t0 = Date.now();
    setTimeout(() => ac.abort(), 300);
    const aborted = await rejection(r.p.exec(id, ["sleep", "10"], {}, c), "an aborted exec");
    if (!isTimeout(r, aborted)) fail(`an aborted exec rejected ${String((aborted as Error)?.message ?? aborted)}, not timeout`);
    if (Date.now() - t0 > 5000) fail(`an exec aborted after 300 ms took ${Date.now() - t0} ms to settle`);
  } },
  { name: "what caps say isn't there is unsupported; sweep exactly when idle machines are swept", async run(r) {
    const d = r.p.describe();
    if ((typeof r.p.sweep === "function") !== (d.caps.idleLifetime === "sweep")) fail(`sweep is ${typeof r.p.sweep === "function" ? "" : "not "}implemented with caps.idleLifetime ${d.caps.idleLifetime}`);
    if (d.caps.egressAllowlist && d.caps.snapshots) return;
    const id = await r.box("caps");
    const unsupported = (e: unknown) => e instanceof PluginError && e.code === "unsupported";
    if (!d.caps.egressAllowlist && !unsupported(await rejection(r.p.setEgress(id, ["example.com"], r.call()), "setEgress without caps.egressAllowlist"))) fail("setEgress without caps.egressAllowlist must reject unsupported");
    if (!d.caps.snapshots && !unsupported(await rejection(r.p.snapshot(id, "capcomd-conformance", r.call()), "snapshot without caps.snapshots"))) fail("snapshot without caps.snapshots must reject unsupported");
  } },
];

/** A fresh run of the suite against `p`. */
function newRun(p: SandboxProvider, opts: SandboxConformanceOptions): Run & { cleanup(): Promise<void> } {
  const o: Options = { name: opts.name ?? null, exec: opts.exec ?? true, prefix: opts.prefix ?? "relay-", scratch: opts.scratch ?? "/tmp", readyMs: opts.readyMs ?? 120_000 };
  const tag = `${process.pid}-${Date.now().toString(36)}`;
  const made = new Set<string>();
  const key = (k: string) => `${o.prefix}conformance-${k}-${tag}`;
  const call = (ms = 60_000) => conformanceCall(ms);
  const spec = (k: string): VmSpec => ({ idemKey: key(k), egressAllow: ["*"], isolated: true, ttlSeconds: 900, labels: { purpose: "conformance" } });
  const r = {
    p, o, made, tag, key, call, spec,
    async box(k: string) {
      const m = await p.ensure(spec(k), call());
      made.add(m.id);
      await p.waitReady(m.id, call(o.readyMs));
      return m.id;
    },
    async cleanup() { for (const id of made) await p.destroy(id, call()).catch(() => {}); },
  };
  return r;
}

/** Each case's runner, sharing one run (its machines destroyed by `cleanup`). */
export function sandboxCases(p: SandboxProvider, opts: SandboxConformanceOptions = {}): { cases: Array<{ name: string; skip: boolean; run(): Promise<void> }>; cleanup(): Promise<void> } {
  const r = newRun(p, opts);
  return {
    cases: SANDBOX_CASES.map((c) => ({ name: c.name, skip: !!c.exec && !r.o.exec, run: () => c.run(r) })),
    cleanup: () => r.cleanup(),
  };
}

/** Run the whole suite against `p` and report every case (`capcomd plugins validate --conformance`). */
export async function runSandboxConformance(p: SandboxProvider, opts: SandboxConformanceOptions & { caseTimeoutMs?: number } = {}): Promise<ConformanceResult[]> {
  const { cases, cleanup } = sandboxCases(p, opts);
  const out: ConformanceResult[] = [];
  try {
    for (const c of cases) {
      if (c.skip) { out.push({ name: c.name, ok: true, skipped: true, ms: 0, message: "the sandbox runs no commands (exec cases skipped)" }); continue; }
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = opts.caseTimeoutMs ?? 180_000;
      try {
        await Promise.race([c.run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${limit} ms`)), limit); })]);
        out.push({ name: c.name, ok: true, skipped: false, ms: Date.now() - t0, message: null });
      } catch (e) {
        out.push({ name: c.name, ok: false, skipped: false, ms: Date.now() - t0, message: e instanceof Error ? e.message : String(e) });
      } finally { clearTimeout(timer); }
    }
  } finally { await cleanup(); }
  return out;
}
