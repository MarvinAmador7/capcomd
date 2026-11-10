// Every agent provider declares its own environment variable families (docs/spec/plugin-api.md §7.3, §6.6.7, §10.3;
// the owner's decision of 2026-11-10): `describe().envPrefixes`. The kernel keeps no list of them: what an
// agent.preparing `env` may not set, what a plugin's secret may not reference and what a check on the host doesn't get
// are the kernel's own families plus every provider's. A provider's families only add protection.
import { afterEach, describe, expect, test } from "bun:test";
import { PluginError } from "../../packages/plugin/src/errors";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { Candidate, PluginHost } from "../../packages/plugin/src/host/host";
import type { AgentPreparing } from "../../packages/plugin/src/hooks";
import type { AgentProvider } from "../../packages/plugin/src/seams";
import { runAgentConformance } from "../../packages/plugin/src/agent-conformance";
import { hostCheckEnv } from "../../src/merge/verify";
import { claude } from "../../src/plugins/agent-claude";
import { codex } from "../../src/plugins/agent-codex";
import { fx } from "../../src/plugins/agent-fx";
import { useAgentSeams } from "../../src/plugins/agents";
import { BUILTINS, candidateOf } from "../../src/plugins/builtins";
import { kernelSecretRef, kernelVariable } from "../../src/plugins/config";
import { agentSeamRefusal, hostCheckDropPrefixes, kernelEnvPrefixes, providerEnvPrefixes, reservedEnvPrefixes } from "../../src/plugins/env-families";
import { applyPreparePatch, reservedEnvName } from "../../src/plugins/hooks";
import { kernelHost } from "../../src/plugins/host";
import { resolveSecret } from "../../src/plugins/secrets";

// The hand-kept lists as they were before the providers declared their families (src/plugins/hooks.ts,
// src/plugins/config.ts, src/merge/verify.ts at 9682e08b).
const RESERVED_BEFORE = ["CAPCOMD_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AI_GATEWAY_", "VERCEL_", "FX_", "LD_", "DYLD_", "NODE_", "NPM_CONFIG_", "PYTHON", "PERL5", "RUBY", "GIT_"];
const KERNEL_BEFORE = ["CAPCOMD_", "RELAY_", "BOXD_", "RIVET", "GIT_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AI_GATEWAY_", "VERCEL_", "FX_"];
const HOST_DROP_BEFORE = /^(CAPCOMD_|RELAY_|BOXD_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|AI_GATEWAY_|VERCEL_|FX_|GH_|GITHUB_|GIT_CONFIG_|GIT_ASKPASS$|SSH_AUTH_SOCK$|AWS_|GOOGLE_|AZURE_|NPM_TOKEN$)|(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const sorted = (a: readonly string[]) => [...a].sort();

/** Names on both sides of every family, in both cases, for comparing the old and the derived behaviour. */
const NAMES = [
  ...["CAPCOMD_X", "RELAY_RPC_KEY", "BOXD_API_KEY", "RIVET_ENDPOINT", "RIVETKIT", "GIT_DIR", "GIT_CONFIG_GLOBAL", "GIT_ASKPASS", "GIT_ASKPASSX", "GITX",
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CLAUDEX", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CODEXX",
    "AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "AI_GATEWAYX", "VERCEL_OIDC_TOKEN", "VERCEL_ORG_ID", "FX_HOME", "FX_PROVIDER", "FXR_MODE",
    "GITHUB_TOKEN", "GITHUB_REPOSITORY", "GH_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "NPM_TOKEN", "NPM_CONFIG_REGISTRY",
    "AWS_REGION", "GOOGLE_CLOUD_PROJECT", "AZURE_TENANT", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONPATH", "PERL5LIB", "RUBYOPT",
    "BASH_ENV", "ENV", "SHELL", "TMPDIR", "HTTP_PROXY", "SSL_CERT_FILE", "PATH", "HOME", "BUN_INSTALL", "PLUGIN_TEAM", "MY_AI_GATEWAY_KEY", "MY_VERCEL_TOKEN", "XYZ_HOME", "XYZ_TOKEN", "CI"],
];
const BOTH_CASES = [...NAMES, ...NAMES.map((n) => n.toLowerCase())];

/** A third-party agent provider (codex's behaviour) declaring the families `prefixes`. */
const provider = (name: string, prefixes: string[]): AgentProvider => ({
  ...codex, describe: () => ({ ...codex.describe(), name, label: name, bin: `${name}-agent`, envPrefixes: [...prefixes] }),
});
const candidate = (name: string, impl: AgentProvider): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name: `agent-${name}`, version: "1.0.0", description: "A test agent provider.", apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, provides: [`seam:agent/${name}`], contributes: { seams: [{ kind: "agent", name }] } },
  module: { activate: (c: PluginContext) => { c.seams.agent(impl); } } as PluginModule<never>,
});
let hosts: PluginHost[] = [];
let failures: Record<string, string> = {};
async function started(...extra: Candidate[]) {
  const h = kernelHost({ log: false, record: (e) => {
    const d = e.data as { plugin?: string; message?: string };
    if (e.type === "plugin.failed" && d.plugin) failures[d.plugin] = d.message ?? "";
    return { seq: 0 };
  } });
  hosts.push(h);
  await h.start([...BUILTINS.filter((b) => (b.manifest as { name: string }).name.startsWith("agent-")).map(candidateOf), ...extra]);
  useAgentSeams(h.contributions);
  return h;
}
afterEach(async () => { useAgentSeams(null); for (const h of hosts) await h.stop(); hosts = []; failures = {}; });

const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof PluginError ? e.code : String(e); } return "ok"; };
const preparing = (env: string[] = []): AgentPreparing => ({ agent: {} as never, spec: {} as never, prompt: { system: null, append: null, skills: [] }, env, egress: [], credentialMode: "secret", sandbox: { provider: "fake", environment: null } });

describe("the providers declare their families (§7.3)", () => {
  test("claude, codex and fx declare theirs, and the conformance suite passes them", () => {
    expect([claude, codex, fx].map((p) => p.describe().envPrefixes)).toEqual([["ANTHROPIC_", "CLAUDE_"], ["OPENAI_", "CODEX_"], ["AI_GATEWAY_", "VERCEL_", "FX_"]]);
    for (const p of [claude, codex, fx]) expect(runAgentConformance(p).filter((r) => r.name.startsWith("describe()"))).toEqual([expect.objectContaining({ ok: true })]);
  });

  test("the derived lists are today's lists, and every check answers as it did, for the three built-ins", async () => {
    for (const listed of [false, true]) {
      if (listed) await started();
      expect(providerEnvPrefixes()).toEqual(["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AI_GATEWAY_", "VERCEL_", "FX_"]);
      expect(sorted(reservedEnvPrefixes())).toEqual(sorted(RESERVED_BEFORE));
      expect(sorted(kernelEnvPrefixes())).toEqual(sorted(KERNEL_BEFORE));
      expect(hostCheckDropPrefixes()).toEqual(expect.arrayContaining(["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AI_GATEWAY_", "VERCEL_", "FX_"]));
      const env = Object.fromEntries(BOTH_CASES.map((n) => [n, "v"]));
      expect(Object.keys(hostCheckEnv(env))).toEqual(BOTH_CASES.filter((n) => !HOST_DROP_BEFORE.test(n)));
      for (const n of BOTH_CASES) {
        expect([n, kernelVariable(n)]).toEqual([n, KERNEL_BEFORE.some((p) => n.toUpperCase().startsWith(p)) || ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(n.toUpperCase())]);
        expect([n, reservedEnvName(n)]).toEqual([n, RESERVED_BEFORE.some((p) => n.startsWith(p)) || ["BASH_ENV", "ENV", "SHELL", "IFS", "CDPATH", "PS4", "PROMPT_COMMAND", "ZDOTDIR", "TMPDIR", "USER", "LOGNAME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"].includes(n)]);
      }
    }
  });

  test("a disabled built-in's families stay protected: the user's keys are still the user's", async () => {
    const h = await started();
    await h.disable("agent-codex");
    expect(providerEnvPrefixes()).toContain("OPENAI_");
    expect(reservedEnvName("OPENAI_BASE_URL")).toBe(true);
    expect(kernelSecretRef("env:OPENAI_API_KEY")).toContain("one of capcomd's own variables");
  });
});

describe("a third-party provider's families (§7.3, §6.6.7, §10.3)", () => {
  test("a provider declaring XYZ_ gets XYZ_ protected in agent.preparing patches, plugin secret references and host checks", async () => {
    expect(reservedEnvName("XYZ_HOME")).toBe(false);
    expect(kernelSecretRef("env:XYZ_TOKEN")).toBeNull();
    const h = await started(candidate("xyz", provider("xyz", ["XYZ_"])));
    expect(h.get("agent-xyz")).toMatchObject({ state: "active" });
    expect(providerEnvPrefixes()).toEqual(["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AI_GATEWAY_", "VERCEL_", "FX_", "XYZ_"]);
    // agent.preparing: widening, whether or not the agent's environment has the name; an attempt's spec drops it.
    for (const k of ["XYZ_HOME", "XYZ_TOKEN"]) expect([k, code(() => applyPreparePatch(preparing(), { env: { [k]: "/tmp/x" } }))]).toEqual([k, "widening"]);
    expect(applyPreparePatch(preparing(), { env: { PLUGIN_TEAM: "payments", XYZX_MODE: "1" } }).env).toEqual(["PLUGIN_TEAM", "XYZX_MODE"]);
    // A plugin's secret reference: refused, in any case, and never read.
    expect(kernelSecretRef("env:XYZ_TOKEN")).toContain("one of capcomd's own variables");
    expect(kernelSecretRef("env:xyz_token")).toContain("one of capcomd's own variables");
    const m = { name: "my-plugin", config: { type: "object", properties: { token: { type: "object", "x-secret": true } } } };
    const env = { CAPCOMD_NO_CONFIG: "1", CAPCOMD_PLUGIN_MY_PLUGIN_TOKEN: '{"$secret":"env:XYZ_TOKEN"}', XYZ_TOKEN: "xyz-secret" };
    expect(code(() => resolveSecret(m as never, "token", env, "/plugins/my-plugin", { builtin: false }))).toBe("forbidden");
    expect(Object.keys(hostCheckEnv({ XYZ_HOME: "/h", PATH: "/bin" }))).toEqual(["PATH"]);
    // The kernel's families are all still there.
    expect(sorted(reservedEnvPrefixes())).toEqual(sorted([...RESERVED_BEFORE, "XYZ_"]));
    expect(sorted(kernelEnvPrefixes())).toEqual(sorted([...KERNEL_BEFORE, "XYZ_"]));
  });

  test("a prefix that isn't a family or would take in a kernel family is refused at registration, and protects nothing", async () => {
    for (const bad of ["", "C", "c_", "XYZ", "C_A-"]) expect([bad, agentSeamRefusal(provider("bad", [bad]))]).toEqual([bad, expect.stringContaining("variable name prefix")]);
    for (const [bad, taken] of [["CAP", null], ["NPM_", "NPM_CONFIG_"], ["GITHUB_", "GITHUB_TOKEN"], ["HTTP_", "HTTP_PROXY"], ["SSL_", "SSL_CERT_FILE"], ["G_", null]] as const) {
      const why = agentSeamRefusal(provider("bad", [bad]));
      if (taken) expect([bad, why]).toEqual([bad, expect.stringContaining(`would take in the kernel's ${taken}`)]);
      else if (bad === "CAP") expect(why).toContain("variable name prefix");
      else expect([bad, why]).toEqual([bad, null]);
    }
    // Equal to a kernel family or inside one adds nothing and takes in nothing: allowed.
    for (const ok of ["CAPCOMD_", "GIT_X_", "CAPCOMD_XYZ_"]) expect([ok, agentSeamRefusal(provider("ok", [ok]))]).toEqual([ok, null]);
    expect(agentSeamRefusal(provider("twice", ["XYZ_", "XYZ_"]))).toContain("listed twice");

    const h = await started(candidate("wide", provider("wide", ["XYZ_", "GITHUB_"])), candidate("cee", provider("cee", ["C"])));
    expect([h.get("agent-wide")?.state, h.get("agent-cee")?.state]).toEqual(["failed", "failed"]);
    expect(failures["agent-wide"]).toContain("the agent seam wide: describe().envPrefixes: GITHUB_ would take in the kernel's GITHUB_TOKEN");
    expect(failures["agent-cee"]).toContain('the agent seam cee: describe().envPrefixes: "C" must be an upper-case variable name prefix');
    expect(providerEnvPrefixes()).toEqual(["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AI_GATEWAY_", "VERCEL_", "FX_"]);
    expect(reservedEnvName("XYZ_HOME")).toBe(false);
    expect(Object.keys(hostCheckEnv({ CI: "1", CC: "cc" }))).toEqual(["CI", "CC"]);
  });

  test("the conformance suite fails a describe() whose envPrefixes isn't a list of families", () => {
    const failed = (p: string[]) => runAgentConformance(provider("x", p)).find((r) => r.name.startsWith("describe()"));
    expect(failed(["XYZ_"])).toMatchObject({ ok: true });
    expect(failed(["C"])).toMatchObject({ ok: false, message: expect.stringContaining("envPrefixes") });
  });
});
