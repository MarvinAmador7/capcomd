// The fx bridge (src/plugins/fx-bridge.mjs) against fx's own ACP sessions: each recorded from fx 0.0.16 with the bridge
// as its client (tests/agents/fixtures/fx/<name>.acp.jsonl) is replayed by a fake fx (fake-fx.mjs), which fails when the
// bridge asks for anything the recording doesn't; the bridge must then print what it printed against the real fx
// (<name>.bridge.jsonl). Messages arrive on stdin as the supervisor writes them, and its input closes as the supervisor
// closes it (a result with nothing sent since). Plus what it sets up for fx: its settings, environment and MCP servers.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fxOrchestrateRules } from "../../src/plugins/agent-fx";
import { ORCHESTRATE_DENIED_COMMANDS } from "../../src/plugins/agent-common";

const BRIDGE = join(import.meta.dir, "..", "..", "src", "plugins", "fx-bridge.mjs");
const FAKE = join(import.meta.dir, "fake-fx.mjs");
const FIX = join(import.meta.dir, "fixtures", "fx");
chmodSync(FAKE, 0o755);
const NODE = Bun.which("node");

interface Run { lines: any[]; code: number | null; home: string; seen: any; seenFile: string; mcp: any; err: string }

/** Runs the bridge with `config` (bin: the fake fx), feeding `prompt` and `messages` as the supervisor does. */
async function bridge(o: { name?: string; prompt: string; stdin?: boolean; config?: Record<string, unknown>; messages?: Array<{ on: (l: any) => boolean; text: string }>; signalOn?: (l: any) => boolean; promptOn?: (l: any) => boolean; home?: string; env?: Record<string, string> }): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-fx-bridge-"));
  const home = o.home ?? join(dir, "home");
  mkdirSync(home, { recursive: true });
  const repo = join(dir, "repo");
  mkdirSync(repo);
  writeFileSync(join(dir, "prompt.txt"), o.prompt);
  const seen = join(dir, "fx-seen.json");
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ bin: FAKE, cwd: repo, prompt: join(dir, "prompt.txt"), stdin: !!o.stdin, provider: "gateway", permission: { mode: "full-access" }, logFile: join(dir, "fx-acp.log"), ...o.config }));
  const p = Bun.spawn([NODE!, BRIDGE, join(dir, "bridge.json")], {
    cwd: repo, stdin: o.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: home, FAKE_FX_SEEN: seen, ...(o.name ? { FAKE_FX_REPLAY: join(FIX, `${o.name}.acp.jsonl`) } : {}), ...o.env },
  });
  const say = (t: string) => { (p.stdin as any).write(JSON.stringify({ type: "user", message: { role: "user", content: t } }) + "\n"); (p.stdin as any).flush?.(); };
  // The prompt is the first line, at once (the supervisor writes it as it starts), or when `promptOn` matches a line.
  let prompted = !o.stdin;
  if (o.stdin && !o.promptOn) { say(o.prompt); prompted = true; }
  const lines: any[] = [];
  const pending = [...(o.messages ?? [])];
  let sentAt = Date.now(), resultAt = 0, closed = false, signalled = false;
  const closer = setInterval(() => {
    if (o.stdin && !closed && resultAt && sentAt <= resultAt && Date.now() - resultAt >= 300 && !pending.length) { closed = true; (p.stdin as any).end(); }
  }, 50);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk);
    let n;
    while ((n = buf.indexOf("\n")) >= 0) {
      const l = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
      lines.push(l);
      if (l.type === "result") resultAt = Date.now();
      if (!prompted && o.promptOn?.(l)) { say(o.prompt); prompted = true; sentAt = Date.now(); }
      // Every message waiting for this line, in order.
      for (let i = pending.findIndex((m) => m.on(l)); i >= 0 && !closed; i = pending.findIndex((m) => m.on(l))) { say(pending.splice(i, 1)[0]!.text); sentAt = Date.now(); }
      if (o.signalOn && !signalled && o.signalOn(l)) { signalled = true; p.kill("SIGTERM"); }
    }
  }
  const code = await p.exited;
  clearInterval(closer);
  const err = await new Response(p.stderr as ReadableStream).text();
  const read = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
  return { lines, code, home, seen: read(seen), seenFile: seen, mcp: read(`${seen}.mcp`), err };
}
const recorded = (name: string) => readFileSync(join(FIX, `${name}.bridge.jsonl`), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const toolCall = (l: any) => l.type === "update" && l.update?.sessionUpdate === "tool_call";

describe.skipIf(!NODE)("the fx bridge against fx 0.0.16's recorded sessions", () => {
  const cases: Array<[string, Parameters<typeof bridge>[0], number]> = [
    ["plain", { prompt: "plain" }, 0],
    ["shell", { prompt: "shell", stdin: true }, 0],
    ["failing", { prompt: "failing", stdin: true }, 0],
    ["edit", { prompt: "edit", stdin: true }, 0],
    // A message while fx works: a steering prompt, absorbed at its next model call.
    ["steer", { prompt: "steer", stdin: true, messages: [{ on: toolCall, text: "Also, the answer must mention the word pineapple." }] }, 0],
    // A message after the turn: the next turn.
    ["followup", { prompt: "followup", stdin: true, messages: [{ on: (l) => l.type === "result", text: "And once more, please." }] }, 0],
    ["auth", { prompt: "auth", stdin: true }, 1],
    // Out of credits: fx retries it as a rate limit; the bridge cancels the turn at once and reports a quota.
    ["credits", { prompt: "credits", stdin: true }, 1],
    // A rate limit that doesn't pass for quotaAfterMs: a quota too.
    ["ratelimit", { prompt: "ratelimit", stdin: true, config: { quotaAfterMs: 300 } }, 1],
    ["steps", { prompt: "steps", stdin: true, config: { maxSteps: 2 } }, 1],
    // Every action fx's rules leave to a person is refused.
    ["orchestrate", { prompt: "orchestrate", stdin: true, config: { permission: { mode: "ask", rules: fxOrchestrateRules(ORCHESTRATE_DENIED_COMMANDS) } } }, 0],
    // fx runs commands in a login shell whose /etc/profile resets PATH: with the bridge's profile line, the agent's
    // tools on its own PATH (a `capcomd` only in /tmp/xbin) were found (recorded: "capcomd-found").
    ["path", { prompt: "path", stdin: true }, 0],
    // SIGTERM mid-turn (the runner stopping it): the turn is cancelled, fx stopped, exit 128 + 15.
    ["kill", { prompt: "kill", stdin: true, signalOn: toolCall }, 143],
    // No credential: fx refuses to start, a setup failure (exit 2).
    ["noauth", { prompt: "noauth", stdin: true }, 2],
  ];
  for (const [name, o, code] of cases) {
    test(`${name}: prints what it printed against the real fx, exits ${code}`, async () => {
      const r = await bridge({ ...o, name });
      if (r.code !== code) throw new Error(`exit ${r.code}: ${r.err}`);
      expect(r.lines).toEqual(recorded(name));
    }, 20_000);
  }

  test("mcp: capcomd's server with an absolute command and its environment as name/value pairs; a missing program and an untrusted server are left out, and said", async () => {
    const cfgFile = join(mkdtempSync(join(tmpdir(), "capcomd-fx-mcp-")), "mcp.json");
    writeFileSync(cfgFile, JSON.stringify({ mcpServers: { capcomd: { command: "node", args: ["/rpc/bin/capcomd", "mcp"], env: { CAPCOMD_RPC_DIR: "/rpc" } }, other: { command: "no-such-program", args: [] }, skipped: { command: "node", args: [] } } }));
    const r = await bridge({ name: "mcp", prompt: "mcp", stdin: true, config: { mcpConfig: cfgFile, mcpServers: ["capcomd", "other"], untrustedMcp: ["untrusted-one"] } });
    expect(r.code).toBe(0);
    expect(r.mcp).toEqual([{ name: "capcomd", command: NODE, args: ["/rpc/bin/capcomd", "mcp"], env: [{ name: "CAPCOMD_RPC_DIR", value: "/rpc" }] }]);
    expect(r.lines).toEqual(recorded("mcp"));
  }, 20_000);
});

describe.skipIf(!NODE)("what the bridge sets up for fx", () => {
  test("its settings: merged into $HOME/.fx/settings.json, private, no upgrades or extra model calls; a full-access agent gets no permission rules", async () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-fx-home-"));
    mkdirSync(join(home, ".fx"), { mode: 0o700 });
    writeFileSync(join(home, ".fx", "settings.json"), JSON.stringify({ providers: { mine: { base_url: "https://x" } }, permission: { "*": "deny" }, auto_upgrade: true }));
    const r = await bridge({ prompt: "fix it", home, config: { model: "anthropic/claude-sonnet-5", effort: "high", maxSteps: 30 } });
    expect(r.code).toBe(0);
    const s = JSON.parse(readFileSync(join(home, ".fx", "settings.json"), "utf8"));
    expect(s).toEqual({ providers: { mine: { base_url: "https://x" } }, auto_upgrade: false, session_titles: false, cache_warming: false, prompt_history: { enabled: false } });
    expect(statSync(join(home, ".fx", "settings.json")).mode & 0o777).toBe(0o600);
    // fx's login shell gets the agent's PATH back from the profile (once, however often the bridge runs).
    expect(r.seen.capcomdPath).toBe(process.env.PATH);
    const profile = readFileSync(join(home, ".bash_profile"), "utf8");
    expect(profile).toBe(`[ -f "$HOME/.profile" ] && . "$HOME/.profile"\n# capcomd: the agent's PATH (fx runs commands in a login shell)\n[ -n "$CAPCOMD_PATH" ] && export PATH="$CAPCOMD_PATH"\n`);
    expect(readFileSync(join(home, ".zprofile"), "utf8")).toContain('export PATH="$CAPCOMD_PATH"');
    await bridge({ prompt: "again", home });
    expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe(profile);
    // How fx was started: its ACP server, the model as a flag, the rest in its environment.
    expect(r.seen.argv).toEqual(["acp", "--model", "anthropic/claude-sonnet-5", "--log-file", expect.stringMatching(/fx-acp\.log$/)]);
    expect(r.seen.env).toEqual({ FX_AUTO_UPGRADE: "0", FX_NO_OPEN_BROWSER: "1", FX_PERMISSION_MODE: "full-access", FX_PROVIDER: "gateway", FX_EFFORT: "high", FX_MAX_AGENT_STEPS: "30" });
    // The scripted fake's turn, end to end.
    expect(r.lines.map((l) => l.type)).toEqual(["init", "session", "message", "update", "update", "update", "update", "update", "update", "message", "update", "result"]);
    expect(r.lines.at(-1)).toEqual({ type: "result", stopReason: "end_turn", usage: { inputTokens: 10000, outputTokens: 1000, cacheReadTokens: 2000 }, lastText: "fixed sum with fx" });
  }, 20_000);

  test("orchestrate: fx in ask mode with capcomd's rules in its settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-fx-home-"));
    const rules = fxOrchestrateRules(ORCHESTRATE_DENIED_COMMANDS);
    const r = await bridge({ prompt: "look", home, config: { permission: { mode: "ask", rules } } });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".fx", "settings.json"), "utf8")).permission).toEqual(rules);
    expect(r.seen.env.FX_PERMISSION_MODE).toBe("ask");
  }, 20_000);

  test("orchestrate: of a settings file already there only the model endpoints stay: a workspace override would outrank capcomd's rules", async () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-fx-home-"));
    mkdirSync(join(home, ".fx"), { mode: 0o700 });
    // What a project's setup could have left in the agent's home: the checkout's workspace entry allowing everything
    // (fx merges it after the top-level rules) and approving the repository's .mcp.json servers.
    const loose = { "*": "allow", bash: { "*": "allow" }, edit: "allow" };
    writeFileSync(join(home, ".fx", "settings.json"), JSON.stringify({ permission: loose, workspaces: { "/w/t1-e1/repo": { permission: loose, enableAllProjectMcpServers: true } }, providers: { mine: { base_url: "https://x" } } }));
    const rules = fxOrchestrateRules(ORCHESTRATE_DENIED_COMMANDS);
    const r = await bridge({ prompt: "look", home, config: { permission: { mode: "ask", rules } } });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, ".fx", "settings.json"), "utf8"))).toEqual({ providers: { mine: { base_url: "https://x" } }, auto_upgrade: false, session_titles: false, cache_warming: false, prompt_history: { enabled: false }, permission: rules });
  }, 20_000);

  test("an API key is the credential: a Vercel OIDC token, which fx would prefer, is dropped; directories it reads beside the checkout are added when they exist", async () => {
    const ctx = mkdtempSync(join(tmpdir(), "capcomd-fx-context-"));
    const r = await bridge({ prompt: "x", env: { AI_GATEWAY_API_KEY: "vck_x", VERCEL_OIDC_TOKEN: "oidc" }, config: { addDirs: [ctx, join(ctx, "missing")] } });
    expect([r.seen.key, r.seen.oidc]).toEqual(["set", null]);
    expect(r.seen.argv.slice(0, 3)).toEqual(["--add-dir", ctx, "acp"]);
  }, 20_000);

  test("a message too big to steer with is the next turn; a steering prompt fx refuses (the turn ended) is the next turn too", async () => {
    const big = "x".repeat(70 * 1024);
    const r = await bridge({ prompt: "first [wait]", stdin: true, messages: [{ on: (l) => toolCall(l) && l.update.toolCallId === "call_1", text: big }, { on: (l) => toolCall(l) && l.update.toolCallId === "call_1", text: "small" }] });
    expect(r.code).toBe(0);
    // Both arrived during the first turn: the big one was queued, "small" went as a steering prompt that fx refused
    // (the turn ended first); the next turn is both of them, in the order they came.
    expect(r.lines.filter((l) => l.type === "steer")).toEqual([{ type: "steer", delivery: "refused", message: "No turn to steer; send it as a new prompt" }]);
    expect(r.lines.filter((l) => l.type === "result").length).toBe(2);
    const prompts = readFileSync(`${r.seenFile}.prompts`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(prompts.map((p) => [p.steer, p.head.slice(0, 12)])).toEqual([[false, "first [wait]"], [true, "small"], [false, "xxxxxxxxxxxx"]]);
    expect(prompts[2].bytes).toBe(big.length + "\n\nsmall".length);
  }, 20_000);

  test("the prompt is the first turn even when a message comes right behind it after fx's session started", async () => {
    // The supervisor writes the prompt as it starts and the inbox's messages after it: when fx was quicker to start its
    // session than they were to arrive, a message right behind the prompt still goes after it.
    const r = await bridge({ prompt: "the task", stdin: true, promptOn: (l) => l.type === "session", messages: [{ on: (l) => l.type === "session", text: "a message" }] });
    expect(r.code).toBe(0);
    const prompts = readFileSync(`${r.seenFile}.prompts`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(prompts.map((p) => [p.steer, p.head])).toEqual([[false, "the task\n\na message"]]);
  }, 20_000);

  test("a missing fx binary is a setup failure: an error line and exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-fx-bridge-"));
    writeFileSync(join(dir, "p.txt"), "x");
    writeFileSync(join(dir, "b.json"), JSON.stringify({ bin: join(dir, "no-fx"), cwd: dir, prompt: join(dir, "p.txt"), permission: { mode: "full-access" } }));
    const p = Bun.spawnSync([NODE!, BRIDGE, join(dir, "b.json")], { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir } });
    expect(p.exitCode).toBe(2);
    expect(JSON.parse(p.stdout.toString().trim().split("\n")[0]!)).toMatchObject({ type: "error", where: "spawn" });
    expect(existsSync(join(dir, ".fx", "settings.json"))).toBe(true);
  }, 20_000);
});
