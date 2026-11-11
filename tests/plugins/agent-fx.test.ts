// The built-in agent-fx plugin (docs/spec/plugin-api.md §7.3, §16.1): fx as the `fx` agent seam. Its stream is what the
// fx bridge prints; the recorded streams in tests/agents/fixtures/fx were made by running the bridge against fx 0.0.16
// itself (a scripted model server in a throwaway container, scripts/fx-record), and replay here through `parse` and
// `outcome` (§14.2). Plus the pieces around it: the install (a release archive checked by its sha256), the orchestrate
// rules, the config the bridge gets, the token rates, and profile validation.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, AgentRunState } from "../../packages/plugin/src/seams";
import { testkit } from "../../packages/plugin/src/testkit";
import { runAgentConformance } from "../../packages/plugin/src/agent-conformance";
import { FX_BRIDGE_SOURCE, FX_CODEX_LOGIN_REFUSED, FX_DEFAULT_USD_PER_MTOK, FX_LOGINS, FX_RELEASE, FX_VERSION, fx, fxOrchestrateRules } from "../../src/plugins/agent-fx";
import { ORCHESTRATE_DENIED_COMMANDS, ORCHESTRATE_READ_COMMANDS } from "../../src/plugins/agent-common";
import { adapterOf, agentProviderNames, seamConfig, useAgentSeams } from "../../src/plugins/agents";
import { AGENTS_SCHEMA, validateSpec } from "../../src/profiles";
import { loadAgentConfig, egressFor, installEgress } from "../../src/agents/config";
import { detectedUsable, detectScript, installScript, installedBin, logLinesOf, parseDetect, REFUSAL } from "../../src/agents/runner";
import { Redactor } from "../../src/agents/redact";
import { BUILTINS } from "../../src/plugins/builtins";
import { doctorAgents } from "../../src/env/doctor";

const FIX = join(import.meta.dir, "..", "agents", "fixtures", "fx");
const fixture = (n: string) => readFileSync(join(FIX, `${n}.bridge.jsonl`), "utf8");
const fresh = (): AgentRunState => ({ events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false });
const cfg = (c: Partial<AgentConfig> = {}): AgentConfig => ({ credentialMode: "auto", ...c });
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function replay(name: string, c: Partial<AgentConfig> = {}) {
  const state = fresh();
  const events = fixture(name).split("\n").filter((l) => l.trim()).map((l) => fx.parse(l, (s) => s, state, cfg(c)));
  return { state, events };
}
/** The bridge config `command` writes, read back out of the shell line. */
function bridgeConfig(line: string): any {
  const m = /printf '%s' '((?:[^']|'\\'')*)' > '[^']*fx-bridge\.json'/.exec(line.replace(/'\\''/g, "'").replace(/'"'"'/g, "'"));
  if (!m) {
    // The config is quoted twice (inside sh -c '…'): undo the outer quoting first.
    const inner = /^sh -c '(.*)' > /s.exec(line)![1]!.replace(/'\\''/g, "'");
    const c = /printf '%s' '((?:[^']|'\\'')*)' > '[^']*fx-bridge\.json'/.exec(inner)!;
    return JSON.parse(c[1]!.replace(/'\\''/g, "'"));
  }
  return JSON.parse(m[1]!);
}
const ctx = (c: Partial<AgentConfig> = {}, extra: Record<string, unknown> = {}) => ({ bin: "/home/a/bin/fx", repo: "/w/t1-e1/repo", promptFile: "/w/t1-e1/prompt.txt", jsonl: "/w/t1-e1/agent.jsonl", errFile: "/w/t1-e1/agent.err", dir: "/w/t1-e1", cfg: cfg(c), ...extra });

afterEach(() => useAgentSeams(null));

// §14.2: the seam's cases, then each recorded stream with the state and outcome it must replay to.
testkit.conformance.agent(() => fx, { name: "fx", streams: [
  { name: "a plain answer", text: fixture("plain"), state: { done: true, turns: 0, inputTokens: 1200, outputTokens: 40, resultText: "Hello from the stub model. The answer is 42.", model: "stub-model" }, outcome: { ok: true, stopReason: "success" } },
  { name: "a shell command", text: fixture("shell"), state: { done: true, turns: 1, inputTokens: 2500, outputTokens: 81 }, outcome: { ok: true } },
  { name: "a command that fails is a result, not a failure", text: fixture("failing"), state: { turns: 1 }, outcome: { ok: true } },
  { name: "a file written and edited", text: fixture("edit"), state: { turns: 2, resultText: "Created and edited notes.txt." }, outcome: { ok: true } },
  { name: "a message steering the turn", text: fixture("steer"), state: { turns: 1 }, outcome: { ok: true } },
  { name: "a message after the turn: the next turn", text: fixture("followup"), state: { inputTokens: 2500, outputTokens: 81 }, outcome: { ok: true } },
  { name: "the credential refused", text: fixture("auth"), state: { error: "configured provider authentication failed · HTTP 401" }, exitCode: 1, outcome: { ok: false, stopReason: "auth" } },
  { name: "no credential at all", text: fixture("noauth"), state: { done: false }, exitCode: 2, outcome: { ok: false, stopReason: "auth" } },
  { name: "out of credits", text: fixture("credits"), exitCode: 1, outcome: { ok: false, stopReason: "quota" } },
  { name: "a rate limit that doesn't pass", text: fixture("ratelimit"), exitCode: 1, outcome: { ok: false, stopReason: "quota" } },
  { name: "fx's step limit", text: fixture("steps"), state: { turns: 2 }, exitCode: 1, outcome: { ok: false, stopReason: "max_turns" } },
  { name: "an orchestrate agent's refused calls", text: fixture("orchestrate"), state: { turns: 12 }, outcome: { ok: true } },
  { name: "capcomd's MCP tool", text: fixture("mcp"), state: { turns: 1 }, outcome: { ok: true } },
  { name: "the agent's PATH in fx's login shell", text: fixture("path"), state: { turns: 1 }, outcome: { ok: true } },
  { name: "stopped mid-turn", text: fixture("kill"), exitCode: 143, outcome: { ok: false, stopReason: "cancelled" } },
] });

describe("agent-fx: describe() and registration (§7.3)", () => {
  test("a built-in plugin with the fx seam, listed after claude and codex", () => {
    expect(BUILTINS.some((b) => (b.manifest as { name: string }).name === "agent-fx")).toBe(true);
    expect(agentProviderNames()).toEqual(["claude", "codex", "fx"]);
  });

  test("pinned release archives with their sha256, no npm package, an AI Gateway key", () => {
    const d = fx.describe();
    expect(d).toMatchObject({ name: "fx", label: "fx", bin: "fx", pinnedVersion: FX_VERSION, secretName: "AI_GATEWAY_API_KEY", apiHost: "ai-gateway.vercel.sh", streamInput: true, defaultEffort: null });
    expect(d.npmPackage).toBeUndefined();
    expect(d.install).toEqual({ kind: "archive", member: "fx", assets: {
      x86_64: { url: "https://releases.fx.sh/v0.0.16/fx-linux-x86_64.tar.gz", sha256: "f0fb822c7be546c80bcc89d50521bc1454435e0c6f586e8420c4e2b84fa80599" },
      aarch64: { url: "https://releases.fx.sh/v0.0.16/fx-linux-aarch64.tar.gz", sha256: "ca9441b104357e2105039dbfd4c2eaf0d6ee65a84085f23f51e880c95cbf46af" },
    } });
    expect(d.efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(d.toolPolicies.orchestrate.denyCommands).toEqual([...ORCHESTRATE_DENIED_COMMANDS]);
    // The runner's adapter carries the install, so it installs the archive and not an npm package.
    expect(adapterOf(fx)).toMatchObject({ kind: "fx", bin: "fx", install: d.install });
  });

  test("conformance refuses a provider with both an npm package and an archive, or an archive without a sha256", () => {
    const both = { ...fx, describe: () => ({ ...fx.describe(), npmPackage: "fx" }) };
    expect(runAgentConformance(both, { name: "fx" }).find((r) => !r.ok)?.message).toBe("describe() must give exactly one of npmPackage and install");
    const unpinned = { ...fx, describe: () => ({ ...fx.describe(), install: { kind: "archive" as const, member: "fx", assets: { ...fx.describe().install!.assets, aarch64: { url: "https://example.com/fx.tgz", sha256: "" } } } }) };
    expect(runAgentConformance(unpinned, { name: "fx" }).find((r) => !r.ok)?.message).toBe("describe().install.assets.aarch64 must be an https url and a sha256");
  });

  test("credentials and environment: the key as AI_GATEWAY_API_KEY, no upgrades, no browser", async () => {
    expect(fx.credentialEnv("bxds_placeholder")).toEqual({ AI_GATEWAY_API_KEY: "bxds_placeholder" });
    expect(fx.baseEnv()).toMatchObject({ FX_AUTO_UPGRADE: "0", FX_NO_OPEN_BROWSER: "1", NO_COLOR: "1" });
    const c = { signal: new AbortController().signal, deadline: new Date(Date.now() + 1000).toISOString(), trace: { traceId: "t", spanId: "s" } };
    const saved = process.env.AI_GATEWAY_API_KEY;
    try {
      delete process.env.AI_GATEWAY_API_KEY;
      expect(await fx.available({ sandbox: "docker", auth: "apikey" }, c)).toMatchObject({ ok: false, reason: "AI_GATEWAY_API_KEY isn't set" });
      process.env.AI_GATEWAY_API_KEY = "vck_test";
      expect(await fx.available({ sandbox: "docker", auth: "apikey" }, c)).toEqual({ ok: true });
    } finally { if (saved === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = saved; }
    expect(fx.classifyError({ kind: "credentials" })).toEqual({ kind: "auth", retryable: false, hint: "Set AI_GATEWAY_API_KEY (an AI Gateway API key), or `capcomd secrets sync` it; on a plan login, run `capcomd auth login fx` again." });
  });

  test("plan logins: Vercel's and Grok's, each with the hosts its login reaches; ChatGPT's refused with what to use instead", () => {
    const d = fx.describe();
    expect(d.subscription).toBeUndefined(); // absent: capcomd has a plan login for fx
    expect(d.logins).toEqual([
      { name: "vercel", label: "Vercel", egress: ["vercel.com", "api.vercel.com", "ai-gateway.vercel.sh"], metered: true },
      { name: "grok", label: "Grok", egress: ["auth.x.ai", "accounts.x.ai", "cli-chat-proxy.grok.com", "api.x.ai"] },
      { name: "codex", label: "ChatGPT", egress: [], refused: FX_CODEX_LOGIN_REFUSED },
    ]);
    expect(FX_CODEX_LOGIN_REFUSED).toContain("localhost:1455");
    expect(FX_CODEX_LOGIN_REFUSED).toContain("capcomd auth login codex");
    // A login VM that doesn't name its login (auth status of an older one, a carry) reaches both logins' hosts.
    expect(d.loginEgress).toEqual(["vercel.com", "api.vercel.com", "ai-gateway.vercel.sh", "auth.x.ai", "accounts.x.ai", "cli-chat-proxy.grok.com", "api.x.ai"]);
    expect(egressFor("fx", "subscription")).toEqual(expect.arrayContaining([...d.loginEgress, FX_RELEASE.host]));
    // fx prints the URL instead of opening a browser, and never upgrades itself in the login VM.
    expect(fx.loginCommand("/h/bin/fx")).toEqual(["env", "FX_NO_OPEN_BROWSER=1", "FX_AUTO_UPGRADE=0", "/h/bin/fx", "login", "vercel"]);
    expect(fx.loginCommand("/h/bin/fx", "grok").slice(-2)).toEqual(["login", "grok"]);
    expect(() => fx.loginCommand("/h/bin/fx", "codex")).toThrow(FX_CODEX_LOGIN_REFUSED);
    expect(adapterOf(fx).logins?.map((l) => l.name)).toEqual(["vercel", "grok", "codex"]);
    // Conformance holds a provider's logins to unique names, hosts, and at least one login it can make.
    const allRefused = { ...fx, describe: () => ({ ...fx.describe(), logins: [{ name: "codex", label: "ChatGPT", egress: [], refused: "no" }] }) };
    expect(runAgentConformance(allRefused, { name: "fx" }).find((r) => !r.ok)?.message).toBe("describe().logins must have one login capcomd can make");
    const twice = { ...fx, describe: () => ({ ...fx.describe(), logins: [FX_LOGINS[0], FX_LOGINS[0]].map((l) => ({ name: l.name, label: l.label, egress: [...l.egress] })) }) };
    expect(runAgentConformance(twice, { name: "fx" }).find((r) => !r.ok)?.message).toBe('describe().logins: "vercel" must be a unique lowercase name');
    const odd = { ...fx, describe: () => ({ ...fx.describe(), logins: [{ name: "vercel", label: "Vercel", egress: [], metered: "yes" as any }] }) };
    expect(runAgentConformance(odd, { name: "fx" }).find((r) => !r.ok)?.message).toBe("describe().logins.vercel.metered must be a boolean");
    expect(adapterOf(fx).logins?.map((l) => !!l.metered)).toEqual([true, false, false]);
  });

  test("a budget holds on a key and on Vercel's login (the AI Gateway bills per token), not on a Grok plan", () => {
    const spent = { ...fresh(), costUsd: 2 };
    const guard = (over: Partial<AgentConfig>) => fx.guard(spent, { credentialMode: "auto", maxBudgetUsd: 1, ...over });
    expect(guard({})).toStartWith("max_budget_usd");
    expect(guard({ credentialMode: "subscription", planLogin: "vercel" })).toStartWith("max_budget_usd");
    // A plan login whose name wasn't recorded is the one `capcomd auth login fx` makes unasked: Vercel's.
    expect(guard({ credentialMode: "subscription" })).toStartWith("max_budget_usd");
    expect(guard({ credentialMode: "subscription", planLogin: "grok" })).toBeNull();
    // The kernel hands the provider the recorded login.
    const ledger = join(mkdtempSync(join(tmpdir(), "capcomd-fx-plan-")), "auths.json");
    writeFileSync(ledger, JSON.stringify({ fx: { agent: "fx", store: "snapshot", snapshot: "capcomd-auth-fx-x", method: "browser-code", login: "grok", env: "capcomd-env-x", createdAt: "t" } }));
    expect(seamConfig(loadAgentConfig({ CAPCOMD_AGENT: "fx", CAPCOMD_CREDENTIALS: "subscription", CAPCOMD_AUTH_LEDGER: ledger }), "fx").planLogin).toBe("grok");
    expect(seamConfig(loadAgentConfig({ CAPCOMD_AGENT: "fx", CAPCOMD_AUTH: "apikey", AI_GATEWAY_API_KEY: "k", CAPCOMD_AUTH_LEDGER: ledger }), "fx").planLogin).toBeUndefined();
  });

  test("on a plan login: the keys fx would prefer dropped, FX_HOME its folder, fx run on the provider the login signed in to", async () => {
    const h = mkdtempSync(join(tmpdir(), "capcomd-fx-sub-"));
    const run = (script: string) => Bun.spawnSync(["sh", "-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AI_GATEWAY_API_KEY: "vck_x", VERCEL_OIDC_TOKEN: "oidc" } }).stdout.toString();
    const shown = `${fx.subscriptionPrelude(h, q)}; echo "key=$AI_GATEWAY_API_KEY oidc=$VERCEL_OIDC_TOKEN home=$FX_HOME provider=$CAPCOMD_FX_PROVIDER"`;
    expect(run(fx.subscriptionCheck(h, q)).trim()).toBe("");
    mkdirSync(join(h, ".fx"));
    writeFileSync(join(h, ".fx", "grok-auth.json"), "{}");
    // Each login found is named, so the kernel bills the agent on what its VM holds.
    expect(run(fx.subscriptionCheck(h, q)).trim()).toBe("file grok");
    expect(run(shown).trim()).toBe(`key= oidc= home=${h}/.fx provider=grok`);
    writeFileSync(join(h, ".fx", "auth.json"), "{}");
    expect(run(fx.subscriptionCheck(h, q)).trim().split("\n")).toEqual(["file vercel", "file grok"]);
    expect(run(shown).trim()).toBe(`key= oidc= home=${h}/.fx provider=gateway`);
    // fx's ChatGPT session isn't a login capcomd made: alone, it is none.
    const other = mkdtempSync(join(tmpdir(), "capcomd-fx-sub-"));
    mkdirSync(join(other, ".fx"));
    writeFileSync(join(other, ".fx", "chatgpt-auth.json"), "{}");
    expect(run(fx.subscriptionCheck(other, q)).trim()).toBe("");
    // The bridge gets no provider of its own then: it runs fx on CAPCOMD_FX_PROVIDER.
    expect(bridgeConfig(fx.command(ctx({ credentialMode: "subscription" }), q)).provider).toBeUndefined();
    expect(bridgeConfig(fx.command(ctx({ credentialMode: "auto" }), q)).provider).toBe("gateway");
    expect(fx.verifyCommand("/h/bin/fx", q)).toContain('FX_PROVIDER="${CAPCOMD_FX_PROVIDER:-gateway}"');
    // The check runs on the agent's model when it has one (a Token Pass covers only its featured models), else fx's default.
    expect(fx.verifyCommand("/h/bin/fx", q)).not.toContain("--model");
    expect(fx.verifyCommand("/h/bin/fx", q, "zai/glm-5.3")).toContain(`--model ${q("zai/glm-5.3")}`);
    const c = { signal: new AbortController().signal, deadline: new Date(Date.now() + 1000).toISOString(), trace: { traceId: "t", spanId: "s" } };
    const ledger = join(h, "auths.json");
    const saved = process.env.CAPCOMD_AUTH_LEDGER;
    try {
      process.env.CAPCOMD_AUTH_LEDGER = ledger;
      expect(await fx.available({ sandbox: "boxd", auth: "subscription" }, c)).toMatchObject({ ok: false, fix: "Run `capcomd auth login fx` (a Vercel login), or `capcomd auth login fx grok` (a Grok plan)." });
      writeFileSync(ledger, JSON.stringify({ fx: { agent: "fx", store: "snapshot", snapshot: "capcomd-auth-fx-x", method: "browser-code", login: "grok", env: "capcomd-env-x", createdAt: "t" } }));
      expect(await fx.available({ sandbox: "boxd", auth: "subscription" }, c)).toEqual({ ok: true });
    } finally { if (saved === undefined) delete process.env.CAPCOMD_AUTH_LEDGER; else process.env.CAPCOMD_AUTH_LEDGER = saved; }
  });

  test("the login check prints only whether fx sees a login, never what `fx status --json` says besides", () => {
    const d = mkdtempSync(join(tmpdir(), "capcomd-fx-status-"));
    const fake = join(d, "fx");
    const check = (auth: string, pretty = false) => {
      const body = JSON.stringify({ kind: "status", auth, auth_refreshable: true, session: "vcr_SECRET" }, null, pretty ? 2 : 0);
      writeFileSync(fake, `#!/bin/sh
[ "$1" = status ] && [ "$2" = --json ] && [ "$FX_PROVIDER" = grok ] && cat <<'EOF'
${body}
EOF
`);
      chmodSync(fake, 0o755);
      return Bun.spawnSync(["sh", "-c", fx.loginCheck!(fake, q)], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CAPCOMD_FX_PROVIDER: "grok" } }).stdout.toString();
    };
    expect(check("fx login")).toBe('{"loggedIn":true}\n');
    expect(check("fx login", true)).toBe('{"loggedIn":true}\n');
    expect(check("missing")).toBe('{"loggedIn":false}\n');
    expect(check("fx login")).not.toContain("vcr_SECRET");
  });

  test("doctor checks fx only when its key is set here: one nobody configured isn't this machine failing (doctor --strict, capcomd setup)", () => {
    expect(doctorAgents({}).map((a) => a.kind)).toEqual(["claude-code", "codex"]);
    expect(doctorAgents({ AI_GATEWAY_API_KEY: "vck_x" }).map((a) => a.kind)).toEqual(["claude-code", "codex", "fx"]);
  });

  test("egress: the AI Gateway, and its release host for the install (an env build's VM reaches it too)", () => {
    expect(egressFor("fx", "apikey")).toEqual(["github.com", "ai-gateway.vercel.sh", "releases.fx.sh", "registry.npmjs.org", "nodejs.org"]);
    expect(installEgress()).toEqual(["releases.fx.sh"]);
  });
});

describe("agent-fx: parse, guard, outcome", () => {
  test("every string passes through redact, the bridge's lines included", () => {
    const state = fresh();
    const r = (s: string) => s.split("SECRET-123").join("[REDACTED]");
    const lines = [
      { type: "message", role: "agent", text: "key SECRET-123" },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "c1", name: "shell", kind: "execute", rawInput: { action: "run", command: "echo SECRET-123" } } },
      { type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", content: [{ type: "content", content: { type: "text", text: "SECRET-123" } }] } },
      { type: "result", stopReason: "refused", usage: {}, lastText: "SECRET-123 refused" },
      { type: "error", where: "prompt", message: "SECRET-123" },
    ];
    const evs = lines.map((l) => fx.parse(JSON.stringify(l), r, state, cfg()));
    expect(JSON.stringify(evs)).not.toContain("SECRET-123");
    expect(JSON.stringify(state)).not.toContain("SECRET-123");
  });

  test("tool calls: the call and its result for the stuck watch, a command waited on from start to end, fx's internal steps no turn", () => {
    const { events, state } = replay("shell");
    const call = events.find((e) => e?.calls)!;
    expect(call.calls).toEqual(['command "echo hello-from-shell && ls"']);
    expect(call.tool).toBe("Bash(echo hello-from-shell && ls)");
    expect(call.commands).toEqual({ started: ["call_shell_0"] });
    const done = events.find((e) => e?.results)!;
    expect(done.results).toEqual([{ call: 'command "echo hello-from-shell && ls"' }]);
    expect(done.commands).toEqual({ ended: ["call_shell_0"] });
    expect(state.turns).toBe(1);
    // A failed command carries its output as the error.
    expect(replay("failing").events.find((e) => e?.results)!.results).toEqual([{ call: 'command "ls /no/such/dir"', error: "ls: cannot access '/no/such/dir': No such file or directory\n" }]);
    // fx's own bookkeeping (internal: true) isn't a turn.
    const s = fresh();
    fx.parse(JSON.stringify({ type: "update", update: { sessionUpdate: "tool_call", toolCallId: "i1", name: "capability_search", kind: "other", rawInput: {}, _meta: { fx: { toolCall: { internal: true } } } } }), (x) => x, s, cfg());
    fx.parse(JSON.stringify({ type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "i1", status: "completed" } }), (x) => x, s, cfg());
    expect(s.turns).toBe(0);
  });

  test("a call fx's rules or the bridge refused shows as refused in the agent's log", () => {
    const { events } = replay("orchestrate");
    const lines = events.flatMap((e) => (e ? logLinesOf(e as any) : []));
    // Each line is `refused <call>: <fx's denial>`.
    expect(lines.filter((l) => l.startsWith("refused ")).map((l) => l.slice(0, l.indexOf(": {")))).toEqual([
      'refused command "git commit -m x"',
      'refused write_file {"path":"blocked.txt","content":"no\\n"}',
      'refused command "capcomd status && rm -rf x"',
      'refused command "uname -a"',
      'refused command "echo hi > redirect.txt"',
      'refused command "ls | head -1"',
      'refused command "git branch -D nothing"',
      'refused command "git log --output=out.txt"',
    ]);
    expect(REFUSAL.test('{"error":{"type":"tool_permission_denied"}}')).toBe(true);
  });

  test("tokens add up over turns and cost is tokens × rates (fx reports no cost): the operator's, else a conservative default", () => {
    const { state } = replay("followup");
    expect([state.inputTokens, state.outputTokens]).toEqual([2500, 81]);
    expect(state.costUsd).toBeCloseTo((2500 * FX_DEFAULT_USD_PER_MTOK.in + 81 * FX_DEFAULT_USD_PER_MTOK.out) / 1e6, 10);
    const cheap = replay("followup", { usdPerMtok: { in: 1, out: 2 } }).state;
    expect(cheap.costUsd).toBeCloseTo((2500 * 1 + 81 * 2) / 1e6, 10);
    // Cache reads are input too, billed at a tenth.
    const s = fresh();
    fx.parse(JSON.stringify({ type: "result", stopReason: "end_turn", usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100, reasoningTokens: 50 }, lastText: "ok" }), (x) => x, s, cfg({ usdPerMtok: { in: 10, out: 10 } }));
    expect([s.inputTokens, s.cacheReadTokens, s.outputTokens]).toEqual([10000, 9000, 150]);
    expect(s.costUsd).toBeCloseTo((1000 * 10 + 9000 * 1 + 150 * 10) / 1e6, 10);
  });

  test("CAPCOMD_FX_USD_PER_MTOK_IN/_OUT reach the provider; codex keeps its own", () => {
    const c = loadAgentConfig({ CAPCOMD_AGENT: "fx", AI_GATEWAY_API_KEY: "k", CAPCOMD_FX_USD_PER_MTOK_IN: "3", CAPCOMD_FX_USD_PER_MTOK_OUT: "15" });
    expect(seamConfig(c, "fx").usdPerMtok).toEqual({ in: 3, out: 15 });
    expect(seamConfig(c, "codex").usdPerMtok).toEqual({ in: 1.25, out: 10 });
    expect(seamConfig(loadAgentConfig({ CAPCOMD_AGENT: "fx", AI_GATEWAY_API_KEY: "k" }), "fx").usdPerMtok).toEqual({ ...FX_DEFAULT_USD_PER_MTOK });
    expect(() => loadAgentConfig({ CAPCOMD_AGENT: "fx", AI_GATEWAY_API_KEY: "k", CAPCOMD_FX_USD_PER_MTOK_IN: "3" })).toThrow("CAPCOMD_FX_USD_PER_MTOK_IN and _OUT go together: set both");
  });

  test("guard: tool steps over maxTurns, estimated spend over the budget (not on a plan)", () => {
    expect(fx.guard({ ...fresh(), turns: 6 }, cfg({ maxTurns: 5 }))).toBe("max_turns (6 > 5 tool steps)");
    expect(fx.guard({ ...fresh(), turns: 5 }, cfg({ maxTurns: 5 }))).toBeNull();
    expect(fx.guard({ ...fresh(), costUsd: 1.5 }, cfg({ maxBudgetUsd: 1 }))).toBe("max_budget_usd (~$1.500 > $1)");
    expect(fx.guard({ ...fresh(), costUsd: 1.5 }, cfg({ maxBudgetUsd: 1, credentialMode: "subscription", planLogin: "grok" }))).toBeNull();
  });

  test("a later turn that ends well clears an earlier turn's failure; a quota or a bridge error doesn't clear", () => {
    const s = fresh();
    const p = (o: unknown) => fx.parse(JSON.stringify(o), (x) => x, s, cfg());
    p({ type: "result", stopReason: "refused", usage: {}, lastText: "API request failed · HTTP 500" });
    expect(fx.outcome(s, 0)).toEqual({ ok: false, stopReason: "refusal" });
    p({ type: "result", stopReason: "end_turn", usage: {}, lastText: "done after all" });
    expect(fx.outcome(s, 0)).toEqual({ ok: true, stopReason: "success" });
    p({ type: "quota", message: "Rate limited · HTTP 429" });
    p({ type: "result", stopReason: "end_turn", usage: {}, lastText: "late" });
    expect(fx.outcome(s, 0)).toEqual({ ok: false, stopReason: "quota" });
    expect(s.quota).toEqual({ message: "Rate limited · HTTP 429" });
  });

  test("an out-of-credits turn end is a quota; the step limit is max_turns; the auth text is auth", () => {
    const end = (lastText: string) => { const s = fresh(); fx.parse(JSON.stringify({ type: "result", stopReason: "refused", usage: {}, lastText }), (x) => x, s, cfg()); return s; };
    expect(end("HTTP 402: credit_card_required").stopReason).toBe("quota");
    expect(end("Agent step limit reached; continue with a follow-up prompt if needed.").stopReason).toBe("max_turns");
    expect(end("AI_GATEWAY_API_KEY authentication failed · HTTP 401").stopReason).toBe("auth");
    expect(end("Content filtered").stopReason).toBe("refusal");
  });
});

describe("agent-fx: the command and the bridge's config", () => {
  test("one shell line the runner's timeout wraps: it writes the bridge and its config, then becomes node; stdout to ctx.jsonl", () => {
    const line = fx.command(ctx({ model: "anthropic/claude-sonnet-5", effort: "high", maxTurns: 40 }), q);
    expect(line.startsWith("sh -c '")).toBe(true);
    expect(line.endsWith(" > '/w/t1-e1/agent.jsonl' 2> '/w/t1-e1/agent.err' < /dev/null")).toBe(true);
    expect(line).toContain("exec node");
    expect(bridgeConfig(line)).toEqual({
      bin: "/home/a/bin/fx", cwd: "/w/t1-e1/repo", prompt: "/w/t1-e1/prompt.txt", stdin: false, model: "anthropic/claude-sonnet-5", effort: "high",
      provider: "gateway", permission: { mode: "full-access" }, logFile: "/w/t1-e1/fx-acp.log", addDirs: ["/w/context"], maxSteps: 40,
    });
    // The bridge itself goes in whole: the shell line holds its source.
    expect(line.replace(/'\\''/g, "'").replace(/'\\''/g, "'")).toContain("fx acp");
    expect(FX_BRIDGE_SOURCE.length).toBeLessThan(48 * 1024);
    // With messages on stdin, stdin stays the supervisor's.
    expect(fx.command(ctx({}, { stdinPrompt: true }), q).endsWith("2> '/w/t1-e1/agent.err'")).toBe(true);
  });

  test("MCP: capcomd's own and the profile's trusted servers start; an untrusted one doesn't (fx would run its tools unasked)", () => {
    const line = fx.command(ctx({}, { capcomd: { cli: "/rpc/bin/capcomd", mcpConfig: "/w/t1-e1/capcomd-mcp.json" }, mcp: { config: "/w/t1-e1/mcp.json", servers: [{ name: "docs", command: ["docs-mcp"], trust: "trusted" }, { name: "web", command: ["web-mcp"], trust: "untrusted" }] } }), q);
    expect(bridgeConfig(line)).toMatchObject({ mcpConfig: "/w/t1-e1/mcp.json", mcpServers: ["capcomd", "docs"], untrustedMcp: ["web"] });
  });

  test("orchestrate (§16.1): ask mode with capcomd's rules, and no profile server", () => {
    const line = fx.command(ctx({ denyCommands: [...ORCHESTRATE_DENIED_COMMANDS] }, { capcomd: { cli: "/rpc/bin/capcomd", mcpConfig: "/w/t1-e1/capcomd-mcp.json" }, mcp: { config: "/w/t1-e1/mcp.json", servers: [{ name: "docs", command: ["docs-mcp"], trust: "trusted" }] } }), q);
    const c = bridgeConfig(line);
    expect(c.permission).toEqual({ mode: "ask", rules: fxOrchestrateRules(ORCHESTRATE_DENIED_COMMANDS) });
    expect(c.mcpServers).toEqual(["capcomd"]);
  });

  test("the orchestrate rules: reads and capcomd allowed, edits and fx's subagents denied, the read commands allowed and the denied ones denied after them", () => {
    const r = fxOrchestrateRules(ORCHESTRATE_DENIED_COMMANDS) as Record<string, any>;
    expect(r).toMatchObject({ "*": "ask", read: "allow", glob: "allow", grep: "allow", "mcp_capcomd_*": "allow", edit: "deny", subagent: "deny", install_skill: "deny" });
    // fx: the last matching rule wins, by the order of the object's keys.
    const keys = Object.keys(r.bash);
    expect(keys[0]).toBe("*");
    for (const c of ORCHESTRATE_READ_COMMANDS) expect([r.bash[c], r.bash[`${c} *`]]).toEqual(["allow", "allow"]);
    for (const c of ORCHESTRATE_DENIED_COMMANDS) expect([r.bash[c], r.bash[`${c} *`]]).toEqual(["deny", "deny"]);
    expect(keys.indexOf("git commit")).toBeGreaterThan(keys.indexOf("git log *"));
    expect(r.bash["git * --output*"]).toBe("deny");
    expect(keys.at(-1)).toBe("git *--output=*");
  });
});

describe("agent-fx: install (a release archive, checked by its sha256)", () => {
  const home = () => mkdtempSync(join(tmpdir(), "capcomd-fx-home-"));
  /** A release-like archive holding `fx`, which prints `version`; and the provider's adapter pointing at it. */
  function archive(version: string, sha?: string) {
    const d = mkdtempSync(join(tmpdir(), "capcomd-fx-rel-"));
    mkdirSync(join(d, "pkg"));
    writeFileSync(join(d, "pkg", "fx"), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(d, "pkg", "fx"), 0o755);
    Bun.spawnSync(["tar", "-czf", join(d, "fx.tgz"), "-C", join(d, "pkg"), "fx"]);
    const sum = sha ?? createHash("sha256").update(readFileSync(join(d, "fx.tgz"))).digest("hex");
    const asset = { url: `file://${join(d, "fx.tgz")}`, sha256: sum };
    const a = { ...adapterOf(fx), install: { kind: "archive" as const, member: "fx", assets: { x86_64: asset, aarch64: asset } } };
    return a;
  }
  const config = loadAgentConfig({ CAPCOMD_AGENT: "fx", AI_GATEWAY_API_KEY: "k" });
  const run = (script: string) => Bun.spawnSync(["sh", "-c", script], { env: { PATH: process.env.PATH! } });

  test("installs the archive's binary as <home>/bin/fx when its sha256 matches", () => {
    const h = home(), a = archive(FX_VERSION);
    const r = run(installScript(config, h, a));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().split("\n").at(-1)).toBe(FX_VERSION);
    expect(installedBin(a, h)).toBe(`${h}/bin/fx`);
    expect(existsSync(`${h}/bin/fx`)).toBe(true);
    // Run again: the pinned version is there, nothing is downloaded.
    const again = run(installScript(config, h, { ...a, install: { ...a.install, assets: { x86_64: { url: "file:///nonexistent", sha256: "0".repeat(64) }, aarch64: { url: "file:///nonexistent", sha256: "0".repeat(64) } } } }));
    expect(again.exitCode).toBe(0);
  });

  test("refuses an archive whose sha256 doesn't match: nothing from it is installed", () => {
    const h = home(), a = archive(FX_VERSION, "0".repeat(64));
    const r = run(installScript(config, h, a));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain(`fx ${FX_VERSION}: the downloaded archive's sha256 is`);
    expect(existsSync(`${h}/bin/fx`)).toBe(false);
  });

  test("detection takes only capcomd's own <home>/bin/fx at the pinned version, never another `fx` on PATH", () => {
    const h = home(), other = mkdtempSync(join(tmpdir(), "capcomd-fx-other-"));
    // The JSON viewer named fx.
    writeFileSync(join(other, "fx"), "#!/bin/sh\necho 35.0.0\n");
    chmodSync(join(other, "fx"), 0o755);
    const a = adapterOf(fx);
    const det = parseDetect(Bun.spawnSync(["sh", "-c", detectScript(a, h)], { env: { PATH: `${other}:${process.env.PATH}` } }).stdout.toString());
    expect(det.bin).toBeUndefined();
    mkdirSync(join(h, "bin"));
    writeFileSync(join(h, "bin", "fx"), `#!/bin/sh\necho 0.0.15\n`);
    chmodSync(join(h, "bin", "fx"), 0o755);
    const old = parseDetect(Bun.spawnSync(["sh", "-c", detectScript(a, h)], { env: { PATH: `${other}:${process.env.PATH}` } }).stdout.toString());
    expect(old.bin).toBe(join(h, "bin", "fx"));
    // An older fx is installed over: only the pin runs.
    expect(detectedUsable(a, config, old)).toBe(false);
    expect(detectedUsable(a, config, { ...old, version: FX_VERSION })).toBe(true);
    expect(detectedUsable(a, config, { bin: join(h, "bin", "fx"), version: FX_VERSION })).toBe(false);
  });
});

describe("agent-fx in profiles (ADR-024 harness.provider, model, effort)", () => {
  test("a profile on fx validates, with a key or a plan login; its effort is one of fx's levels", () => {
    expect(validateSpec("fxw", { provider: "fx", auth: "apikey", model: "anthropic/claude-sonnet-5", effort: "high" })).toEqual([]);
    expect(validateSpec("fxw", { provider: "fx", auth: "apikey", effort: "ultra" })).toEqual(["agents.fxw: effort must be one of none, minimal, low, medium, high, xhigh, max for provider fx"]);
    expect(validateSpec("fxw", { provider: "fx", auth: "subscription" })).toEqual([]);
    // A provider that says it has no plan login is still refused one.
    useAgentSeams({ list: () => [{ value: { seam: "agent", impl: { ...fx, describe: () => ({ ...fx.describe(), subscription: false }) } } }] } as any);
    expect(validateSpec("fxw", { provider: "fx", auth: "subscription" })).toEqual(['agents.fxw: auth "subscription": capcomd has no plan login for fx; use auth: "apikey" with AI_GATEWAY_API_KEY']);
  });

  test("`capcomd auth login fx [vercel|grok]`: Vercel's by default; ChatGPT's refused before anything starts, with what to use instead", async () => {
    const { parseAgentArg, parseLoginArg } = await import("../../src/auth/login");
    expect(parseAgentArg("fx")).toBe("fx");
    expect(parseLoginArg("fx", undefined)).toBe("vercel");
    expect(parseLoginArg("fx", "grok")).toBe("grok");
    expect(() => parseLoginArg("fx", "codex")).toThrow(FX_CODEX_LOGIN_REFUSED);
    expect(() => parseLoginArg("fx", "github")).toThrow('fx has no login "github": one of vercel, grok');
    expect(parseLoginArg("codex", undefined)).toBeUndefined();
    expect(() => parseLoginArg("codex", "grok")).toThrow("codex has one plan login: run `capcomd auth login codex`");
  });

  test("an orchestrate profile on fx runs with fx's tool policy: its denied commands, which the provider turns into fx's rules", () => {
    const path = join(mkdtempSync(join(tmpdir(), "capcomd-fx-agents-")), "agents.json");
    writeFileSync(path, JSON.stringify({ schema: AGENTS_SCHEMA, agents: { lead: { provider: "fx", auth: "apikey", toolMode: "orchestrate", children: { allowSpawn: true, allowedChildProfiles: ["w"] } }, w: { provider: "fx", auth: "apikey" } } }));
    const c = loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, AI_GATEWAY_API_KEY: "k" }, "lead");
    expect(c.toolMode).toBe("orchestrate");
    expect(c.denyCommands).toEqual([...ORCHESTRATE_DENIED_COMMANDS]);
    expect(bridgeConfig(adapterOf(fx).command({ bin: "fx", repo: "/r", promptFile: "/p", jsonl: "/j", errFile: "/e", dir: "/w/x", cfg: c }, q)).permission.mode).toBe("ask");
  });

  test("the runner's redactor reaches the provider's parse", () => {
    const r = new Redactor(["vck_supersecret_value_123"]);
    const ev = adapterOf(fx).parse(JSON.stringify({ type: "message", role: "agent", text: "my key is vck_supersecret_value_123" }), r, fresh(), loadAgentConfig({ CAPCOMD_AGENT: "fx", AI_GATEWAY_API_KEY: "k" }));
    expect(ev?.text).not.toContain("vck_supersecret_value_123");
  });
});
