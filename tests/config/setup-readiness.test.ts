// capcomd_setup / `capcomd setup check` readiness: only what this project's runs use gates it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loginSteps, loginsNeeded } from "../../src/cli/commands/setup";

const projectWith = (agents: Record<string, unknown>) => {
  const d = mkdtempSync(join(tmpdir(), "capcomd-ready-"));
  mkdirSync(join(d, ".capcomd"));
  writeFileSync(join(d, ".capcomd", "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", agents }));
  return d;
};
const AUTH = [
  { agent: "claude-code", present: true, valid: true, detail: "logged in", store: "snapshot" },
  { agent: "codex", present: false, detail: "no profile (capcomd auth login codex)" },
];

describe("plan logins", () => {
  test("a Claude-only project needs only the Claude login: a missing Codex login doesn't make it not ready", () => {
    const d = projectWith({ worker: { provider: "claude", auth: "subscription" }, reviewer: { provider: "claude", auth: "subscription" } });
    const needed = loginsNeeded(d, { CAPCOMD_NO_CONFIG: "1" });
    expect([...needed!]).toEqual(["claude-code"]);
    const steps = loginSteps(AUTH, needed, "docker");
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(steps[1]).toMatchObject({ step: "codex login", ok: true, detail: expect.stringContaining("not needed: no profile here uses codex") });
    expect(steps[1]!.hint).toBeUndefined();
  });
  test("a profile on Codex with a plan login needs it; API-key profiles need none", () => {
    const both = loginsNeeded(projectWith({ a: { provider: "claude", auth: "subscription" }, b: { provider: "codex", auth: "subscription" } }), { CAPCOMD_NO_CONFIG: "1" });
    expect(loginSteps(AUTH, both, "docker")[1]).toMatchObject({ ok: false, hint: expect.stringContaining("capcomd auth login codex --sandbox docker") });
    const keys = loginsNeeded(projectWith({ a: { provider: "codex", auth: "apikey" } }), { CAPCOMD_NO_CONFIG: "1" });
    expect([...keys!]).toEqual([]);
    expect(loginSteps(AUTH, keys, "docker").every((s) => s.ok)).toBe(true);
  });
  test("a profile on fx with a plan login needs fx's login (not Claude's), and says how to make it", async () => {
    const needed = loginsNeeded(projectWith({ a: { provider: "fx", auth: "subscription" } }), { CAPCOMD_NO_CONFIG: "1" });
    expect([...needed!]).toEqual(["fx"]);
    expect(loginSteps([...AUTH, { agent: "fx", present: false }], needed, "boxd")[2]).toMatchObject({ step: "fx login", ok: false, hint: "Run `capcomd auth login fx --sandbox boxd` in a terminal." });
    // `capcomd profiles list`: an fx profile's readiness is fx's key or login, not Anthropic's.
    const { readiness } = await import("../../src/cli/commands/profiles");
    const dir = mkdtempSync(join(tmpdir(), "capcomd-ready-fx-"));
    const ledger = join(dir, "auths.json");
    expect(readiness("gw", { provider: "fx", auth: "apikey" } as any, { ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({ ready: false, detail: "AI_GATEWAY_API_KEY not set" });
    expect(readiness("gw", { provider: "fx", auth: "subscription" } as any, { CAPCOMD_AUTH_LEDGER: ledger })).toEqual({ ready: false, detail: "not logged in: capcomd auth login fx" });
    writeFileSync(ledger, JSON.stringify({ fx: { agent: "fx", store: "snapshot", snapshot: "capcomd-auth-fx-x", method: "device-auth", login: "vercel", env: "e", createdAt: "t" } }));
    expect(readiness("gw", { provider: "fx", auth: "subscription" } as any, { CAPCOMD_AUTH_LEDGER: ledger })).toEqual({ ready: true, detail: "logged in (capcomd-auth-fx-x)" });
  });
  test("no profiles to tell from (not set up yet): every login counts, as before", () => {
    const d = mkdtempSync(join(tmpdir(), "capcomd-ready-none-"));
    expect(loginsNeeded(d, { CAPCOMD_NO_CONFIG: "1", CAPCOMD_AGENTS_FILE: join(d, "missing.json") })).toBeNull();
    expect(loginSteps(AUTH, null, "docker")[1]).toMatchObject({ ok: false });
  });
});

describe("capacity before a project is set up", () => {
  test("the sandbox setup found (e.g. the user config's) is the one capacity is about, not the process default", async () => {
    const { runCapacity } = await import("../../src/mcp/driver");
    expect(await runCapacity(null, "boxd")).toMatchObject({ sandbox: "boxd", detail: expect.stringContaining("boxd cloud VM") });
    expect((await runCapacity(null)).sandbox).toBe("fake"); // nothing configured: the engine's own (the test fake)
  });
});
