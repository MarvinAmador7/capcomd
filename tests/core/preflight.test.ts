import { describe, expect, test } from "bun:test";
import { runPreflight, preflightNeeded } from "../../src/core/preflight";
import { mapBoxdError, isBoxdAuthError, SandboxAuthError, SandboxConfigError } from "../../src/providers/boxd-errors";

class AuthenticationError extends Error {}
const BOXD = "bxd_live_SECRETKEY_0123456789abcdef";
const ANTH = "sk-ant-api03-SECRET-0123456789abcdefghijklmnop";
const env = { CAPCOMD_SANDBOX: "boxd", CAPCOMD_AGENT: "claude-code", BOXD_API_KEY: BOXD, ANTHROPIC_API_KEY: ANTH };
const okFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

describe("preflight", () => {
  test("only for CAPCOMD_SANDBOX=boxd (skippable)", () => {
    expect(preflightNeeded({})).toBe(false);
    expect(preflightNeeded({ CAPCOMD_SANDBOX: "boxd" })).toBe(true);
    expect(preflightNeeded({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_SKIP_PREFLIGHT: "1" })).toBe(false);
  });

  test("both keys valid", async () => {
    let usedKey = "";
    let headers: any;
    const r = await runPreflight(env, { boxdList: async (k) => { usedKey = k; return []; }, fetch: (async (_u: any, i: any) => { headers = i.headers; return new Response("{}"); }) as any });
    expect(r.every((c) => c.ok)).toBe(true);
    expect(usedKey).toBe(BOXD);
    expect(headers["x-api-key"]).toBe(ANTH);
  });

  test("boxd auth rejection → clear message, no key material", async () => {
    const r = await runPreflight({ ...env, BOXD_API_KEY: ` ${BOXD}\n` }, { boxdList: async () => { throw new AuthenticationError(`invalid or expired API key ${BOXD}`); }, fetch: okFetch });
    const b = r.find((c) => c.name === "boxd")!;
    expect(b.ok).toBe(false);
    expect(b.detail).toContain("BOXD_API_KEY was rejected");
    expect(JSON.stringify(r)).not.toContain(BOXD);
  });

  test("anthropic 401 → clear message; missing keys reported; no key material", async () => {
    const r = await runPreflight(env, { boxdList: async () => [], fetch: (async () => new Response("bad " + ANTH, { status: 401 })) as any });
    expect(r.find((c) => c.name === "anthropic")).toMatchObject({ ok: false });
    expect(r.find((c) => c.name === "anthropic")!.detail).toContain("ANTHROPIC_API_KEY was rejected (HTTP 401)");
    const m = await runPreflight({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_AGENT: "claude-code" }, { boxdList: async () => [], fetch: okFetch });
    expect(m.map((c) => c.detail)).toEqual(["BOXD_API_KEY is not set", "ANTHROPIC_API_KEY is not set"]);
    expect(JSON.stringify(r)).not.toContain(ANTH);
  });

  test("anthropic check only with the claude-code agent", async () => {
    const r = await runPreflight({ CAPCOMD_SANDBOX: "boxd", BOXD_API_KEY: BOXD }, { boxdList: async () => [] });
    expect(r.map((c) => c.name)).toEqual(["boxd"]);
  });
});

describe("boxd auth errors are non-retryable config errors", () => {
  test("mapping and detection (also across an actor boundary as text)", () => {
    const e = mapBoxdError(new AuthenticationError("invalid or expired API key"), undefined, "machines.create");
    expect(e).toBeInstanceOf(SandboxAuthError);
    expect(e).toBeInstanceOf(SandboxConfigError);
    expect((e as SandboxAuthError).retryable).toBe(false);
    expect(e.message).toContain("BOXD_API_KEY was rejected");
    expect(isBoxdAuthError(new Error("actor error: AuthenticationError: invalid or expired API key"))).toBe(true);
    expect(isBoxdAuthError({ grpcCode: 16, message: "x" })).toBe(true);
    expect(isBoxdAuthError(new Error("timeout"))).toBe(false);
  });
});

