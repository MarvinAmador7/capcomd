// The context layer, step 2's capture (ADR-025 §5.1, §8, §13): the seeded secret scan that refuses rather than
// redacts, the secrets a run is seeded with, the candidates one agent's result.data.context makes (attribution and
// provenance from the kernel's records, never from the payload; refused for a secret, a bad shape, the size and the
// run's limit), and the context plugin's agent.changed listener that collects them once, from the record the agent's
// token wrote, with plugin.context.proposed and plugin.context.refused on the run. Engine-free; the end to end run is
// tests/scenarios/context-capture.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { samplePayload, testkit } from "../../packages/plugin/src/testkit";
import type { AgentChanged } from "../../packages/plugin/src/hooks";
import { capture, type CaptureRecord } from "../../src/context/capture";
import { runSecrets, secretScan } from "../../src/context/scan";
import * as contextPlugin from "../../src/plugins/context";

const RUN_SECRET = "correct horse battery staple 4417";   // a value no shape would catch: only the seeding does
const SHAPED = "sk-ant-api03-CAPTUREFIXTURE-abcdefghijklmnopqrstuvwxyz0123456789";
const ORIGIN = { runId: "run-test1", agentId: "agt-test1", profile: "planner", model: "claude-opus-5-5", image: null };
const AT = "2026-11-06T12:00:00.000Z";
const scan = secretScan([RUN_SECRET]);

describe("the seeded secret scan (ADR-025 §8): it refuses, it never redacts", () => {
  test("a run's secret, a credential's shape, a random-looking string, a credentials path, each named in the kernel's words", () => {
    expect(scan(`the deploy needs ${RUN_SECRET} first`)).toEqual({ reason: "secret", what: "a secret value of the run" });
    // Behind an invisible character it is still found.
    expect(scan(`x ${RUN_SECRET.slice(0, 9)}​${RUN_SECRET.slice(9)} y`)?.reason).toBe("secret");
    expect(scan(`key ${SHAPED}`)?.reason).toBe("token");
    for (const t of ["AKIAABCDEFGHIJKLMNOP", "-----BEGIN OPENSSH PRIVATE KEY-----", "https://deploy:hunter2pass@example.com/repo.git", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) expect(scan(t)?.reason).toBe("token");
    expect(scan("token Zx81mQ2rT9vB4nK7wP3sL6yH0cJ5dF1gA8uE")?.reason).toBe("entropy");
    for (const t of ["copy .env.example to .env first", "certs/server.pem", "read ~/.aws/credentials", "k8s/secrets/prod.yaml", "~/.ssh/id_ed25519"]) expect(scan(t)?.reason).toBe("path");
  });

  test("what a lesson often says isn't a secret: commit ids, process.env, code names, a secrets.ts module, uuids", () => {
    for (const t of [
      "fixed in a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 (see 9f8e7d6)",
      "read process.env.CAPCOMD_HOME, never import.meta.env",
      "buildBriefForProfileWithLimits2026 and normalizeResultWithTruncation in src/plugins/secrets.ts",
      "the run id 6f1c2a4e-9b7d-4c3e-8f2a-1d5b6c7e8f90 and tests/scenarios/run-cancel.test.ts",
      "Money is rounded half-even (src/money.js), never with Math.round",
    ]) expect(scan(t)).toBeNull();
    // Values too short to mean anything aren't seeded.
    expect(secretScan(["abc", "", null, undefined])("abc")).toBeNull();
  });

  test("the run's secrets: the agent providers' credentials and every variable named like a credential, not numbers or paths", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { ANTHROPIC_API_KEY: "anthropic-fixture-value-1", GITHUB_TOKEN: "github-fixture-value-2", MY_SERVICE_PASSWORD: "service-fixture-value-3", CAPCOMD_TOKEN_TTL_MS: "1800000", CAPCOMD_SECRET_FILE: "/tmp/somewhere/secret.txt", CAPCOMD_RPC_KEY: "rpc-signing-fixture-4" });
      const s = await runSecrets();
      expect(s).toEqual(expect.arrayContaining(["anthropic-fixture-value-1", "github-fixture-value-2", "service-fixture-value-3", "rpc-signing-fixture-4"]));
      expect(s).not.toContain("1800000");
      expect(s).not.toContain("/tmp/somewhere/secret.txt");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("the candidates in one agent's result.data.context (ADR-025 §5.1)", () => {
  const input = (raw: unknown, o: Partial<Parameters<typeof capture>[0]> = {}) => capture({ raw, origin: ORIGIN, at: AT, scan, itemBytes: 4096, room: null, ...o });

  test("provenance is the kernel's: what an element says about who wrote it, or how far it is trusted, is ignored", () => {
    const r = input([{ title: "Rounding", text: "Money is rounded half-even in src/money.js", by: "human:the-boss", origin: { agentId: "agt-someone-else" }, provenance: { method: "human-authored" }, status: "stable", verified: [{ by: "human:x" }] }]);
    expect(r.refused).toEqual([]);
    expect(r.ignored).toEqual(["by", "origin", "provenance", "status", "verified"]);
    expect(r.accepted).toEqual([{
      id: "agt-test1.1", bytes: 42,
      proposal: { text: { text: "Money is rounded half-even in src/money.js", untrusted: true, by: "agt-test1" }, title: "Rounding", type: "lesson", op: "add" },
      provenance: { method: "agent-generated", by: "process:agt-test1", at: AT, origin: ORIGIN, sources: [] },
    }]);
  });

  test("refused: a run's secret or a token (never redacted), not a lesson, over itemBytes, past the run's room", () => {
    const r = input([
      { text: `deploys need ${RUN_SECRET}` },
      { title: `a ${SHAPED} in the title`, text: "fine text" },
      "just a string",
      { text: "" },
      { text: "a fine lesson", type: "Not A Type" },
      { text: "supersede what?", op: "supersede" },
      { text: "x".repeat(5000) },
      { text: "the first one that fits" },
      { text: "the second one that fits", op: "deprecate", target: { id: "old-rounding" } },
      { text: "one too many" },
    ], { room: 2 });
    expect(r.refused.map((x) => [x.n, x.reason])).toEqual([[1, "secret"], [2, "token"], [3, "invalid"], [4, "invalid"], [5, "invalid"], [6, "invalid"], [7, "too_large"], [10, "over_cap"]]);
    expect(JSON.stringify(r.refused)).not.toContain(RUN_SECRET);
    expect(r.accepted.map((c) => c.id)).toEqual(["agt-test1.8", "agt-test1.9"]);
    expect(r.accepted[1]!.proposal).toMatchObject({ op: "deprecate", target: { provider: "memory", id: "old-rounding", version: "" } });
    expect(input("not a list")).toEqual({ accepted: [], refused: [], ignored: [] });
  });
});

describe("the context plugin collects them when an agent ends (agent.changed ended)", () => {
  const saved = { ...contextPlugin.captureKernel };
  afterEach(() => { Object.assign(contextPlugin.captureKernel, saved); });

  /** The kernel as capture sees it: the result a token wrote, the run's records kept in memory. */
  function kernel(declared: { writer: string | null; value: unknown } | null) {
    const records = new Map<string, CaptureRecord>();
    Object.assign(contextPlugin.captureKernel, {
      declared: async () => declared,
      spec: async () => ({ model: "claude-opus-5-5" }),
      taken: async () => [...records.values()].reduce((n, r) => n + r.candidates.length, 0),
      record: async (_runId: string, rec: CaptureRecord) => { if (records.has(rec.agentId)) return false; records.set(rec.agentId, rec); return true; },
      secrets: async () => [RUN_SECRET],
    });
    return records;
  }
  const ended = (data: unknown, status: "done" | "failed" | "cancelled" = "done"): AgentChanged => {
    const p = samplePayload("agent.changed");
    return { ...p, change: { kind: "ended", status, result: { ok: status === "done", summary: null, claim: null, data, spent: {} } } };
  };

  test("from the record the agent's token wrote, not the payload: kept, refused, each once, with events that never hold a secret", async () => {
    // The payload (redacted on its way, and the agent's to shape) says only that there is something to read.
    const payloadData = { context: [{ text: "what the payload says", by: "human:forged" }] };
    const records = kernel({ writer: "agt-test1", value: { summary: "done", data: { context: [{ text: "Money is rounded half-even", title: "Rounding", by: "human:forged", origin: { agentId: "agt-other" } }, { text: `deploys need ${RUN_SECRET}` }] } } });
    const fake = testkit.fakeContext(contextPlugin.manifest);
    await testkit.load(fake, contextPlugin.plugin as never);
    const first = await fake.fire("agent.changed", ended(payloadData), { runId: "run-test1" });
    expect(first.failure).toBeNull();
    const rec = records.get("agt-test1")!;
    expect(rec.candidates.map((c) => [c.id, c.proposal.text.text, c.provenance.by, c.provenance.origin])).toEqual([["agt-test1.1", "Money is rounded half-even", "process:agt-test1", { runId: "run-test1", agentId: "agt-test1", profile: "worker", model: "claude-opus-5-5", image: null }]]);
    expect(rec.refused).toEqual([{ n: 2, reason: "secret" }]);
    const events = fake.emitted();
    expect(events.map((e) => e.type)).toEqual(["plugin.context.proposed", "plugin.context.refused"]);
    expect(events[0]).toMatchObject({ stream: "run-test1", data: { agentId: "agt-test1", candidate: { id: "agt-test1.1" }, ignored: ["by", "origin"] } });
    expect(events[1]).toMatchObject({ stream: "run-test1", data: { agentId: "agt-test1", n: 2, reason: "secret" } });
    expect(JSON.stringify(events)).not.toContain(RUN_SECRET);
    expect(JSON.stringify(events)).not.toContain("what the payload says");
    // The same change told again (a replay): nothing more.
    await fake.fire("agent.changed", ended(payloadData), { runId: "run-test1" });
    expect(fake.emitted().length).toBe(2);
    await fake.dispose();
  });

  test("nothing when the result isn't the agent's own token's, when it was cancelled, or when no lesson was proposed", async () => {
    const records = kernel({ writer: "agt-someone-else", value: { data: { context: [{ text: "a lesson" }] } } });
    const fake = testkit.fakeContext(contextPlugin.manifest);
    await testkit.load(fake, contextPlugin.plugin as never);
    await fake.fire("agent.changed", ended({ context: [{ text: "a lesson" }] }));
    kernel({ writer: "agt-test1", value: { data: { context: [{ text: "a lesson" }] } } });
    await fake.fire("agent.changed", ended({ context: [{ text: "a lesson" }] }, "cancelled"));
    await fake.fire("agent.changed", ended({ passed: true }));
    await fake.fire("agent.changed", samplePayload("agent.changed"));
    expect(records.size).toBe(0);
    expect(fake.emitted()).toEqual([]);
    await fake.dispose();
  });

  test("a kernel that fails is logged, never thrown (the listener's failures would suspend the brief too)", async () => {
    kernel(null);
    contextPlugin.captureKernel.declared = async () => { throw new Error("engine away"); };
    const fake = testkit.fakeContext(contextPlugin.manifest);
    await testkit.load(fake, contextPlugin.plugin as never);
    for (let i = 0; i < 4; i++) expect((await fake.fire("agent.changed", ended({ context: [{ text: "a lesson" }] }))).failure).toBeNull();
    // Each call ran the listener (none was skipped as suspended), and each failure was logged.
    expect(fake.logs().filter((l) => /could not collect/.test(l.message)).length).toBe(4);
    await fake.dispose();
  });
});
