// The out-of-process runtime (plugin API §9, §17.2 step 9) with a real child process: the proc-gate fixture
// (tests/plugins/fixtures/proc-gate, the fake-claude.sh pattern), started by the kernel's launcher (src/plugins/process.ts)
// and talking to the gateway (src/api/server.ts) over a plugin socket. The environment it gets, its token, the
// handshake's checks, hook calls and answers, a deadline, a crash in flight, restarts and their limit, a handshake that
// never comes, a stream that goes away, events and storage over the wire, and dispose.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { kernelHost, pluginDataDir, userPlugins } from "../../src/plugins/host";
import { loadManifest } from "../../packages/plugin/src/load";
import { pluginStore } from "../../src/plugins/storage";
import { harnessApp, pluginsOnly } from "../../src/api/server";
import { serveHarnessSocket } from "../../src/api/socket";
import { memorySource } from "../../src/api/source";
import { addClient, loadClients, mintPluginClient, pluginClients } from "../../src/api/clients";
import type { ProcessTimings } from "../../packages/plugin/src/host/process";
import type { PluginHost } from "../../packages/plugin/src/host/host";

const MAIN = join(import.meta.dir, "fixtures", "proc-gate", "main.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPERATOR = { principal: { kind: "operator" as const, clientId: null }, entity: "mrg-1" };
const merge = { merge: { mrgId: "mrg-1", runId: "run-1", ref: "agt-1", target: "trunk" } } as never;

type Boot = { host: PluginHost; events: Array<{ type: string; data: Record<string, any> }>; data: string; dir: string; app: ReturnType<typeof harnessApp>; stop(): Promise<void> };
const live: Boot[] = [];
afterEach(async () => { for (const b of live.splice(0)) await b.stop().catch(() => {}); });

async function boot(o: { name?: string; hooks?: Record<string, object>; control?: object; timings?: ProcessTimings; manifest?: Record<string, unknown>; clientsPath?: string; log?: boolean } = {}): Promise<Boot> {
  const name = o.name ?? `proc-gate-${Math.random().toString(36).slice(2, 8)}`;
  const dir = mkdtempSync(join(tmpdir(), "cpp-"));
  const plugin = join(dir, "p");
  mkdirSync(plugin);
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({
    schema: "capcomd.plugin/v1", name, version: "1.0.0", description: "proc-gate, from a test", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
    entry: { runtime: "process", command: ["bun", MAIN], env: { PROC_GATE_MARK: "from the manifest" } }, scopes: ["read", "steer"],
    contributes: { hooks: o.hooks ?? { "merge.landing": {}, "run.changed": {} }, events: ["answered"] }, ...(o.manifest ?? {}),
  }));
  const data = pluginDataDir(name);
  mkdirSync(data, { recursive: true });
  if (o.control) writeFileSync(join(data, "control.json"), JSON.stringify(o.control));
  const events: Boot["events"] = [];
  const sock = join(dir, "s.sock");
  const host = kernelHost({ record: (e) => { events.push(e); return { seq: events.length }; }, log: o.log ?? false, jobs: true, process: { socket: sock, ...(o.timings ? { timings: o.timings } : {}) } });
  const app = harnessApp({ source: memorySource({}), clients: () => (o.clientsPath ? loadClients(o.clientsPath) : []), pluginHost: host, pluginStorage: (n) => pluginStore(n, pluginDataDir(n)) });
  const served = await serveHarnessSocket(sock, pluginsOnly((r) => app.fetch(r)));
  const b: Boot = { host, events, data, dir, app, stop: async () => { await host.stop(); served.close(); rmSync(dir, { recursive: true, force: true }); } };
  live.push(b);
  await host.start([{ source: "user", dir: plugin }]);
  return b;
}
const frames = (b: Boot) => (existsSync(join(b.data, "frames.ndjson")) ? readFileSync(join(b.data, "frames.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const nameOf = (b: Boot) => b.host.list()[0]!.name;
const until = async (what: () => boolean, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (what()) return; throw new Error("timed out"); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("the out-of-process runtime", () => {
  test("starts the process with only the filtered environment; secrets come once in the handshake, never in env", async () => {
    const secret = "proc-gate-secret-value-0123456789";
    Object.assign(process.env, { PROC_GATE_SECRET: secret, GITHUB_TOKEN: "ghp_notforplugins000000000000000000000", BOXD_API_KEY: "bxd_notforplugins", ANTHROPIC_API_KEY: "sk-ant-notforplugins", CAPCOMD_RPC_KEY: "kernel-only", NODE_OPTIONS: "--max-old-space-size=4096", LC_ALL: "C" });
    try {
      const b = await boot({ manifest: { config: { type: "object", additionalProperties: false, properties: { apiKey: { type: "string", "x-secret": true, default: { $secret: "env:PROC_GATE_SECRET" } }, channel: { type: "string", default: "#ops" } } } } });
      const [p] = b.host.list();
      expect(p).toMatchObject({ runtime: "process", source: "user", state: "active", hooks: ["merge.landing", "run.changed"] });
      const env = JSON.parse(readFileSync(join(b.data, "env.json"), "utf8")) as Record<string, string>;
      const allowed = new Set(["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR", "PROC_GATE_MARK", "CAPCOMD_PLUGIN_NAME", "CAPCOMD_PLUGIN_ROOT", "CAPCOMD_PLUGIN_DATA", "CAPCOMD_PLUGIN_SOCKET", "CAPCOMD_PLUGIN_SESSION", "CAPCOMD_PLUGIN_TOKEN", "CAPCOMD_PLUGIN_PROTOCOL"]);
      // What the OS itself may set is the only other thing a process may see: not the daemon's BUN_OPTIONS or NODE_*,
      // which the test preload sets in the daemon (the guard), nor its locale beyond LANG.
      const extra = Object.keys(env).filter((k) => !allowed.has(k) && !/^(_|PWD|OLDPWD|SHLVL|__CF[A-Z_]*)$/.test(k));
      expect(extra).toEqual([]);
      expect(env).toMatchObject({ PROC_GATE_MARK: "from the manifest", CAPCOMD_PLUGIN_NAME: p!.name, CAPCOMD_PLUGIN_PROTOCOL: "1", CAPCOMD_PLUGIN_TOKEN: "(set)", CAPCOMD_PLUGIN_DATA: b.data });
      for (const k of ["GITHUB_TOKEN", "BOXD_API_KEY", "ANTHROPIC_API_KEY", "CAPCOMD_RPC_KEY", "CAPCOMD_HOME", "CAPCOMD_ENDPOINT", "PROC_GATE_SECRET"]) expect(env[k]).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(secret);
      const opened = JSON.parse(readFileSync(join(b.data, "opened.json"), "utf8"));
      expect(opened).toMatchObject({ protocol: 1, plugin: { name: p!.name, scopes: ["read", "steer"] }, config: { channel: "#ops" }, hookTimeoutsMs: { "merge.landing": 10_000, "run.changed": 30_000 } });
      expect(opened.config.apiKey).toBeUndefined();
      expect(opened.secrets).toEqual({ apiKey: createHash("sha256").update(secret).digest("hex") });
      // The detail route shows the config, never the secret.
      expect(JSON.stringify(b.host.detail(p!.name))).not.toContain(secret);
      expect(b.events.map((e) => e.type)).toEqual(expect.arrayContaining(["plugin.process_changed", "plugin.loaded"]));
      expect(b.events.find((e) => e.type === "plugin.loaded")!.data).toMatchObject({ runtime: "process" });
    } finally { for (const k of ["PROC_GATE_SECRET", "GITHUB_TOKEN", "BOXD_API_KEY", "ANTHROPIC_API_KEY", "CAPCOMD_RPC_KEY", "NODE_OPTIONS", "LC_ALL"]) delete process.env[k]; }
  }, 30_000);

  test("what the process writes is the daemon's log, with its token and its secrets redacted", async () => {
    const secret = "proc-gate-secret-value-for-the-log";
    process.env.PROC_GATE_SECRET = secret;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const b = await boot({ log: true, control: { print: true }, manifest: { config: { type: "object", properties: { apiKey: { type: "string", "x-secret": true, default: { $secret: "env:PROC_GATE_SECRET" } } } } } });
      const name = nameOf(b);
      await until(() => lines.filter((l) => l.includes(`"plugin":"${name}"`) && l.includes("secrets")).length === 2);
      const mine = lines.filter((l) => l.includes(`"plugin":"${name}"`));
      expect(mine.join("\n")).not.toContain(secret);
      expect(mine.map((l) => JSON.parse(l))).toEqual(expect.arrayContaining([
        expect.objectContaining({ level: "info", message: "token [REDACTED] secrets [REDACTED]" }),
        expect.objectContaining({ level: "warn", message: "secrets [REDACTED]", fields: { token: "[REDACTED]" } }),
      ]));
    } finally { console.log = log; delete process.env.PROC_GATE_SECRET; }
  }, 30_000);

  test("a gate call goes to the process and its answer decides; observe calls arrive too", async () => {
    const b = await boot();
    const name = nameOf(b);
    const denied = await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR);
    expect(denied).toMatchObject({ decision: "deny", plugin: name, text: "the process gate lands nothing", failure: null });
    writeFileSync(join(b.data, "control.json"), JSON.stringify({ "merge.landing": "allow" }));
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, { ...OPERATOR, attempt: 2 })).toMatchObject({ decision: "allow" });
    writeFileSync(join(b.data, "control.json"), JSON.stringify({ "merge.landing": "hold" }));
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, { ...OPERATOR, attempt: 3 })).toMatchObject({ decision: "hold", plugin: name });
    b.host.hooks.fire("run.changed", "observe", { run: { id: "run-1" }, change: { kind: "started" } } as never, { ...OPERATOR, entity: "run-1" });
    await until(() => frames(b).some((f) => f.hook === "run.changed"));
    const calls = frames(b).filter((f) => f.hook === "merge.landing");
    expect(calls.map((f) => f.key)).toEqual(["merge.landing:mrg-1:1", "merge.landing:mrg-1:2", "merge.landing:mrg-1:3"]);
    expect(calls.map((f) => f.subject)).toEqual(["mrg-1", "mrg-1", "mrg-1"]);
  }, 30_000);

  test("an answer of the wrong shape is 422 to the process and fails the call, which a gate denies", async () => {
    const b = await boot({ control: { "merge.landing": "invalid" } });
    const out = await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR);
    expect(out).toMatchObject({ decision: "deny", failure: "invalid_result" });
    await until(() => frames(b).some((f) => f.answerRefused));
    expect(frames(b).find((f) => f.answerRefused).error).toMatch(/^422/);
    expect(b.events.find((e) => e.type === "plugin.hook_failed")!.data).toMatchObject({ kind: "invalid_result", effect: "denied" });
  }, 30_000);

  test("past its deadline a gate call is denied (timeout), and the late answer is 409", async () => {
    const b = await boot({ hooks: { "merge.landing": { timeoutMs: 1500 } }, control: { "merge.landing": "slow", slowMs: 2500 } });
    const t0 = Date.now();
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR)).toMatchObject({ decision: "deny", failure: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2400);
    await until(() => frames(b).some((f) => f.answerRefused));
    expect(frames(b).find((f) => f.answerRefused).error).toMatch(/^409/);
  }, 30_000);

  test("a crash with a gate call in flight denies it (crashed); the process starts again with a new session and token", async () => {
    const b = await boot({ control: { "merge.landing": "crash" }, timings: { backoffMs: () => 200 } });
    const name = nameOf(b);
    const first = JSON.parse(readFileSync(join(b.data, "opened.json"), "utf8")).session as string;
    const tokens = pluginClients().filter((c) => c.plugin === name).map((c) => c.id);
    expect(tokens).toHaveLength(1);
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR)).toMatchObject({ decision: "deny", plugin: name, failure: "crashed" });
    expect(b.events.find((e) => e.type === "plugin.hook_failed")!.data).toMatchObject({ kind: "crashed", effect: "denied" });
    writeFileSync(join(b.data, "control.json"), JSON.stringify({ "merge.landing": "allow" }));
    await until(() => { try { return JSON.parse(readFileSync(join(b.data, "opened.json"), "utf8")).session !== first; } catch { return false; } });
    await until(() => b.events.filter((e) => e.type === "plugin.process_changed" && e.data.event === "started").length === 2);
    expect(b.events.filter((e) => e.type === "plugin.process_changed").map((e) => e.data.event)).toEqual(["started", "exited", "restarting", "started"]);
    // The old token is gone; one new token works.
    const now = pluginClients().filter((c) => c.plugin === name).map((c) => c.id);
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(tokens[0]);
    // Its listener stayed registered all along, so the next merge is asked again, of the new process.
    await sleep(300);
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, { ...OPERATOR, attempt: 2 })).toMatchObject({ decision: "allow" });
    expect(b.host.list()[0]).toMatchObject({ state: "active" });
  }, 30_000);

  test("exits past the restart budget fail the plugin (restart_limit); its gate keeps denying until it is enabled", async () => {
    const b = await boot({ control: { "merge.landing": "crash" }, timings: { backoffMs: () => 100, restartLimit: 3 } });
    writeFileSync(join(b.data, "control.json"), JSON.stringify({ "merge.landing": "crash", atStart: "exit" }));
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR)).toMatchObject({ decision: "deny", failure: "crashed" });
    await until(() => b.host.list()[0]!.state === "failed");
    expect(b.host.list()[0]).toMatchObject({ state: "failed", cause: "restart_limit" });
    expect(pluginClients().filter((c) => c.plugin === nameOf(b))).toEqual([]);
    // A crash-looping gate denies (§11.3): the merge isn't let through unjudged, and it is denied at once, not at the
    // deadline. An observe hook is skipped.
    expect(b.host.hooks.listening("merge.landing")).toBe(true);
    const t0 = Date.now();
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, { ...OPERATOR, attempt: 2 })).toMatchObject({ decision: "deny", plugin: nameOf(b), failure: "crashed", text: expect.stringContaining("restart_limit") });
    expect(Date.now() - t0).toBeLessThan(1000);
    b.host.hooks.fire("run.changed", "observe", { run: { id: "run-1" }, change: { kind: "started" } } as never, { ...OPERATOR, entity: "run-1" });
    // capcomd plugins enable starts it over: a new process, asked once (the held listener is gone).
    writeFileSync(join(b.data, "control.json"), JSON.stringify({ "merge.landing": "allow" }));
    expect(await b.host.enable(nameOf(b))).toMatchObject({ state: "active" });
    const asked = frames(b).filter((f) => f.hook === "merge.landing").length;
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, { ...OPERATOR, attempt: 3 })).toMatchObject({ decision: "allow" });
    expect(frames(b).filter((f) => f.hook === "merge.landing")).toHaveLength(asked + 1);
  }, 30_000);

  test("a plugin failed by restart_limit and then disabled is no longer asked: the operator's call", async () => {
    const b = await boot({ control: { "merge.landing": "crash", atStart: "exit" }, timings: { backoffMs: () => 100, restartLimit: 2 } });
    writeFileSync(join(b.data, "control.json"), JSON.stringify({ "merge.landing": "crash" }));
    expect(b.host.list()[0]).toMatchObject({ state: "failed", cause: "crashed" });
    // Failed at its start (never active), a plugin holds nothing: like an in-process one whose activate threw.
    expect(b.host.hooks.listening("merge.landing")).toBe(false);
    expect(await b.host.enable(nameOf(b))).toMatchObject({ state: "active" });
    writeFileSync(join(b.data, "control.json"), JSON.stringify({ "merge.landing": "crash", atStart: "exit" }));
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR)).toMatchObject({ decision: "deny", failure: "crashed" });
    await until(() => b.host.list()[0]!.state === "failed");
    expect(b.host.hooks.listening("merge.landing")).toBe(true);
    expect(await b.host.disable(nameOf(b))).toMatchObject({ enabled: false });
    expect(b.host.hooks.listening("merge.landing")).toBe(false);
  }, 30_000);

  test("a process that never opens its session fails the plugin (handshake_timeout) and is killed", async () => {
    const b = await boot({ control: { atStart: "hang" }, timings: { connectWithinMs: 1500 } });
    expect(b.host.list()[0]).toMatchObject({ state: "failed", cause: "handshake_timeout" });
    const pid = b.events.find((e) => e.type === "plugin.process_changed")!.data.pid as number;
    await until(() => !alive(pid));
  }, 30_000);

  test("the handshake refuses another manifest (409) and other hooks (422)", async () => {
    const hash = await boot({ control: { atStart: "badHash" } });
    expect(hash.host.list()[0]).toMatchObject({ state: "failed", cause: "crashed" });
    expect(readFileSync(join(hash.data, "refused.txt"), "utf8")).toMatch(/^409: manifestHash/);
    const hooks = await boot({ control: { atStart: "badHooks" } });
    expect(readFileSync(join(hooks.data, "refused.txt"), "utf8")).toMatch(/^422: hooks must be exactly/);
  }, 30_000);

  test("only the plugin's own token reaches its routes; others are refused, and the plugin socket serves plugin tokens only", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "cpp-c-")), "clients.json");
    const operator = addClient("operator", ["read", "steer", "approve", "configure"], path).token;
    const b = await boot({ clientsPath: path });
    const name = nameOf(b);
    const other = mintPluginClient("someone-else", ["read", "steer"]);
    try {
      const post = (p: string, token: string, body: unknown = {}) => b.app.request(p, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "key-0000001" }, body: JSON.stringify(body) });
      for (const t of [operator, other.token]) {
        expect((await post(`/v1/plugins/${name}/sessions`, t, { session: "x", protocol: 1, manifestHash: "0".repeat(64), pid: 1, hooks: [] })).status).toBe(403);
        expect((await b.app.request(`/v1/plugins/${name}/hooks?session=x`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(403);
        expect((await post(`/v1/plugins/${name}/hooks/call_1`, t, { session: "x", result: { decision: "allow" } })).status).toBe(403);
        expect((await post(`/v1/plugins/${name}/events`, t, { type: "answered", stream: "daemon", text: "x", data: {} })).status).toBe(403);
        expect((await b.app.request(`/v1/plugins/${name}/storage/k`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(403);
      }
      // The operator's token works on the API, not on the plugin socket.
      const detail = await b.app.request(`/v1/plugins/${name}`, { headers: { authorization: `Bearer ${operator}` } });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ name, runtime: "process", state: "active", manifest: { entry: { runtime: "process" } }, config: { values: {}, sources: {} } });
      const viaSocket = await fetch(`http://localhost/v1/plugins/${name}`, { unix: join(b.dir, "s.sock"), headers: { authorization: `Bearer ${operator}` } } as RequestInit);
      expect(viaSocket.status).toBe(401);
      // A plugin never turns plugins on or off, even with the configure scope; the operator does (configure, a key).
      const configurer = mintPluginClient("someone-else", ["configure"]);
      try { expect((await post(`/v1/plugins/${name}/disable`, configurer.token)).status).toBe(403); } finally { configurer.revoke(); }
      const off = await post(`/v1/plugins/${name}/disable`, operator);
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ state: "disposed", cause: "disabled" });
      const on = await b.app.request(`/v1/plugins/${name}/enable`, { method: "POST", headers: { authorization: `Bearer ${operator}`, "idempotency-key": "key-0000002" } });
      expect(await on.json()).toMatchObject({ state: "active" });
    } finally { other.revoke(); }
  }, 30_000);

  test("events and storage over the wire: the plugin's own event on the daemon stream, its counter in its data dir", async () => {
    const b = await boot({ control: { "merge.landing": "allow", emit: true, store: true } });
    const name = nameOf(b);
    await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR);
    await until(() => frames(b).some((f) => f.emitted) && existsSync(join(b.data, "storage.json")));
    expect(b.events.find((e) => e.type === `plugin.${name}.answered`)).toMatchObject({ text: "Answered merge.landing.", data: { hook: "merge.landing", decision: "allow" } });
    await until(() => (JSON.parse(readFileSync(join(b.data, "storage.json"), "utf8")).entries.calls?.value ?? 0) === 1);
  }, 30_000);

  test("a hooks stream gone for disconnectMs makes the plugin disconnected: its gate calls fail closed", async () => {
    const b = await boot({ control: { atStart: "noStream" }, timings: { disconnectMs: 500 } });
    await until(() => b.events.some((e) => e.type === "plugin.process_changed" && e.data.event === "disconnected"));
    expect(await b.host.hooks.fire("merge.landing", "veto", merge, OPERATOR)).toMatchObject({ decision: "deny", failure: "disconnected" });
  }, 30_000);

  test("a process a dead daemon left running is killed before the next start, only while its pid runs the recorded command", async () => {
    const { spawn } = await import("node:child_process");
    const leftover = spawn("sleep", ["37"], { detached: true, stdio: "ignore" });
    const other = spawn("sleep", ["38"], { detached: true, stdio: "ignore" });
    try {
      for (const [name, pid, command] of [["proc-gate-left", leftover.pid!, "sleep 37"], ["proc-gate-other", other.pid!, "sleep 99"]] as const) {
        mkdirSync(pluginDataDir(name), { recursive: true });
        writeFileSync(join(pluginDataDir(name), "process.json"), JSON.stringify({ pid, command, daemon: 1 }));
        const b = await boot({ name });
        expect(b.host.list()[0]).toMatchObject({ state: "active" });
        // This start's record replaced it.
        expect(JSON.parse(readFileSync(join(b.data, "process.json"), "utf8"))).toMatchObject({ daemon: process.pid, command: `bun ${MAIN}` });
      }
      await until(() => !alive(leftover.pid!));
      // A pid that runs something else now (a recycled pid) is left alone.
      expect(alive(other.pid!)).toBe(true);
    } finally { for (const p of [leftover, other]) try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }
  }, 30_000);

  test("dispose: session.closing, the process exits, its token is revoked", async () => {
    const b = await boot();
    const name = nameOf(b);
    const pid = b.events.find((e) => e.type === "plugin.process_changed")!.data.pid as number;
    expect(alive(pid)).toBe(true);
    await b.host.disable(name);
    expect(b.host.list()[0]).toMatchObject({ state: "disposed", cause: "disabled" });
    expect(frames(b).some((f) => f.frame === "session.closing" && f.reason === "disabled")).toBe(true);
    await until(() => !alive(pid));
    expect(pluginClients().filter((c) => c.plugin === name)).toEqual([]);
    expect(b.events.some((e) => e.type === "plugin.process_changed" && e.data.event === "restarting")).toBe(false);
  }, 30_000);
});

describe("what the runtime stands on", () => {
  test("the user's plugins are discovered from <home>/plugins, in name order, and a CLI's host runs none", async () => {
    const home = mkdtempSync(join(tmpdir(), "cpp-h-"));
    for (const n of ["zeta", "alpha"]) {
      mkdirSync(join(home, "plugins", n), { recursive: true });
      writeFileSync(join(home, "plugins", n, "plugin.json"), JSON.stringify({ schema: "capcomd.plugin/v1", name: n, version: "1.0.0", description: n, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "process", command: ["bun", MAIN] }, contributes: { hooks: { "run.changed": {} } } }));
    }
    mkdirSync(join(home, "plugins", "not-a-plugin"));
    const found = userPlugins({ CAPCOMD_HOME: home });
    expect(found.map((c) => [c.source, c.dir])).toEqual([["user", join(home, "plugins", "alpha")], ["user", join(home, "plugins", "zeta")]]);
    // Without a launcher (a CLI's local host) a process plugin is listed and never started.
    const local = kernelHost({ log: false });
    await local.start(found);
    expect(local.list().map((p) => `${p.name}:${p.state}`)).toEqual(["alpha:validated", "zeta:validated"]);
    rmSync(home, { recursive: true, force: true });
  });

  test("a process plugin's manifest contributes hooks and events only (§4.9, §9.6)", () => {
    const m = { schema: "capcomd.plugin/v1", name: "remote", version: "1.0.0", description: "x", apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "process", command: ["bun", "x.ts"] } };
    expect(loadManifest({ ...m, contributes: { hooks: { "run.changed": {} }, events: ["seen"] } }).ok).toBe(true);
    for (const c of [{ cli: [{ name: "remote", summary: "x" }] }, { mcp: [{ name: "t", summary: "x" }] }, { seams: [{ kind: "sandbox", name: "remote" }] }, { context: [{ name: "remote", kinds: ["memory"] }] }]) {
      const r = loadManifest({ ...m, ...("seams" in c ? { provides: ["seam:sandbox/remote"] } : "context" in c ? { provides: ["context:remote"] } : {}), contributes: c });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.message).join(" ")).toContain("contributes hooks and events only");
    }
  });

  test("a plugin's storage: the daemon scope in its data dir, a compare-and-swap, the key and size rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cpp-s-"));
    const s = pluginStore("keeper", dir);
    expect(await s.get("daemon", "a/b")).toBeNull();
    expect(await s.put("daemon", "a/b", { n: 1 })).toMatchObject({ key: "a/b", value: { n: 1 }, rev: "1" });
    await expect(s.put("daemon", "a/b", { n: 2 }, null)).rejects.toMatchObject({ code: "conflict" });
    await expect(s.put("daemon", "a/b", { n: 2 }, JSON.stringify({ n: 9 }))).rejects.toMatchObject({ code: "conflict" });
    expect(await s.put("daemon", "a/b", { n: 2 }, JSON.stringify({ n: 1 }))).toMatchObject({ rev: "2" });
    await s.put("daemon", "c", "x");
    expect((await s.list("daemon", "a/")).map((e) => e.key)).toEqual(["a/b"]);
    await s.delete("daemon", "a/b");
    await s.delete("daemon", "a/b");
    expect((await s.list("daemon", "")).map((e) => e.key)).toEqual(["c"]);
    await expect(s.put("daemon", "../x", 1)).rejects.toMatchObject({ code: "invalid" });
    await expect(s.put("daemon", "big", "x".repeat(70_000))).rejects.toMatchObject({ code: "invalid" });
    expect(statSync(join(dir, "storage.json")).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
