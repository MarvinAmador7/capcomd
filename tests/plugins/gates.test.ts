// The gates (docs/spec/plugin-api.md §17.2 step 5): a judge's review report (§6.6.13) and the operator's ask-everyone
// fire (§6.5) in the registry, the built-in reviewer gate's manifest and its answer with no reviewer, and the gates a
// process that isn't the daemon starts for its verifies (§6.1), and what it waits for before it exits. The kernel's side
// end to end: tests/scenarios/gates.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { HostEvent } from "../../packages/plugin/src/host/registry";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { samplePayload } from "../../packages/plugin/src/testkit";
import { BUILTINS } from "../../src/plugins/builtins";
import { gates, hooks, inBackground, settled, useHooks } from "../../src/plugins/hooks";
import { VERSION } from "../../src/utils/self";
import * as gateReviewer from "../../src/plugins/gate-reviewer/index";

const OPERATOR = { kind: "operator" as const, clientId: null };
const at = (entity: string) => ({ principal: OPERATOR, entity, runId: "run-1" });
const plugin = (name: string, h: Record<string, object>, activate: (ctx: PluginContext) => void): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks: h } },
  module: { activate } as PluginModule<never>,
});
async function hostWith(...c: Candidate[]) {
  const events: HostEvent[] = [];
  const host = new PluginHost({ capcomd: VERSION, kernel: [], emit: (e) => { events.push(e); }, dataDir: (n) => join(tmpdir(), "capcomd-gates-test", n) });
  await host.start(c);
  return { host, events };
}
afterEach(() => useHooks(null));

const REVIEW = { profile: "reviewer", agentId: "agt-r", passed: false, reasons: ["x".repeat(600), ...Array.from({ length: 25 }, (_, i) => `r${i}`)], sha: "a".repeat(40), targetSha: "b".repeat(40), startedAt: "2026-11-05T00:00:00.000Z" };

describe("a judge's review (§6.6.13)", () => {
  test("kept with the answer, capped as a reviewer's reasons, in the judges' order", async () => {
    const { host } = await hostWith(
      plugin("a-judge", { "verify.judging": {} }, (ctx) => { ctx.hooks.on("verify.judging", () => ({ decision: "allow" })); }),
      plugin("b-reviewer", { "verify.judging": {} }, (ctx) => { ctx.hooks.on("verify.judging", () => ({ decision: "deny", reason: "the reviewer failed it", reasons: ["wrong"], review: REVIEW })); }),
    );
    const out = await host.hooks.fire("verify.judging", "veto", samplePayload("verify.judging"), at("vfy-1"));
    expect(out).toMatchObject({ decision: "deny", plugin: "b-reviewer", text: "the reviewer failed it", reasons: ["wrong"] });
    expect(out.reviews?.map((r) => r.plugin)).toEqual(["b-reviewer"]);
    const r = out.reviews![0]!.review;
    expect(r).toMatchObject({ profile: "reviewer", agentId: "agt-r", passed: false, sha: REVIEW.sha, targetSha: REVIEW.targetSha, startedAt: REVIEW.startedAt });
    expect(r.reasons.length).toBe(20);
    expect(r.reasons[0]!.length).toBe(500);
  });

  test("a malformed review is a failed call (the gate denies), and only verify.judging carries one", async () => {
    const { host, events } = await hostWith(
      plugin("bad-review", { "verify.judging": {}, "merge.landing": {} }, (ctx) => {
        ctx.hooks.on("verify.judging", () => ({ decision: "allow", review: { ...REVIEW, sha: "" } }) as never);
        ctx.hooks.on("merge.landing", () => ({ decision: "allow", review: REVIEW }) as never);
      }),
    );
    const judged = await host.hooks.fire("verify.judging", "veto", samplePayload("verify.judging"), at("vfy-1"));
    expect(judged).toMatchObject({ decision: "deny", plugin: "bad-review", failure: "invalid_result" });
    const landed = await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"));
    expect(landed).toMatchObject({ decision: "deny", plugin: "bad-review", failure: "invalid_result" });
    expect(events.filter((e) => e.type === "plugin.hook_failed").map((e) => (e.data as { message: string }).message)).toEqual(["review.sha is the commit the reviewer read", "only a verify.judging answer carries a review, not merge.landing's"]);
  });
});

describe("merge --operator asks every landing gate (§6.5)", () => {
  const three = () => hostWith(
    plugin("a-deny", { "merge.landing": {} }, (ctx) => { ctx.hooks.on("merge.landing", () => ({ decision: "deny", reason: "not on Fridays" })); }),
    plugin("b-hold", { "merge.landing": {} }, (ctx) => { ctx.hooks.on("merge.landing", () => ({ decision: "hold", reason: "a person looks first" })); }),
    plugin("c-allow", { "merge.landing": {} }, (ctx) => { ctx.hooks.on("merge.landing", () => { asked.push("c-allow"); return { decision: "allow" }; }); }),
  );
  const asked: string[] = [];

  test("without askAll the first deny stops the chain", async () => {
    asked.length = 0;
    const { host } = await three();
    const out = await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"));
    expect(out).toMatchObject({ decision: "deny", plugin: "a-deny" });
    expect(out.vetoes).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test("with askAll every listener answers; the outcome is the first veto, and every veto is listed in order", async () => {
    asked.length = 0;
    const { host, events } = await three();
    const out = await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), { ...at("mrg-1"), askAll: true });
    expect(out).toMatchObject({ decision: "deny", plugin: "a-deny", text: "not on Fridays" });
    expect(out.vetoes).toEqual([{ plugin: "a-deny", decision: "deny", text: "not on Fridays" }, { plugin: "b-hold", decision: "hold", text: "a person looks first" }]);
    expect(asked).toEqual(["c-allow"]);
    expect(events.filter((e) => e.type === "plugin.gate_denied").map((e) => [e.stream, (e.data as { plugin: string }).plugin])).toEqual([["run-1", "a-deny"], ["run-1", "b-hold"]]);
  });
});

describe("the reviewer gate (§15.3)", () => {
  test("a built-in, shipped with capcomd: the last judge (order post), on verify.starting and verify.judging", async () => {
    const b = BUILTINS.find((x) => (x.manifest as { name: string }).name === "gate-reviewer")!;
    expect(b.everyProcess).toBe(true);
    expect(b.manifest).toMatchObject({ version: VERSION, engines: { capcomd: VERSION }, order: "post", scopes: ["read", "steer"] });
    const { host } = await hostWith(
      { source: "builtin", manifest: b.manifest, module: b.module },
      plugin("zz-judge", { "verify.judging": {} }, (ctx) => { ctx.hooks.on("verify.judging", () => ({ decision: "allow" })); }),
    );
    expect(host.get("gate-reviewer")).toMatchObject({ state: "active", hooks: ["verify.starting", "verify.judging"] });
    expect(host.hooks.order("verify.judging")).toEqual(["zz-judge", "gate-reviewer"]);
    // No reviewer for the verification: it has nothing to say, and starts nothing.
    expect(await host.hooks.fire("verify.judging", "veto", samplePayload("verify.judging"), at("vfy-1"))).toEqual({ decision: "allow" });
    const starting = await host.hooks.fire("verify.starting", "modify", samplePayload("verify.starting"), { ...at("vfy-1"), apply: (p) => p });
    expect(starting).toMatchObject({ decision: "allow", patches: [] });
  });

  test("it fails closed with its own deny, never by failing: its breaker never trips (a suspended gate denies every verify)", async () => {
    const b = BUILTINS.find((x) => (x.manifest as { name: string }).name === "gate-reviewer")!;
    const { host, events } = await hostWith({ source: "builtin", manifest: b.manifest, module: b.module });
    // A reviewer, and a call it cannot judge (here: no tested tree): a deny with the error as its review, every time.
    const sample = samplePayload("verify.judging");
    const payload = { ...sample, reviewer: "reviewer", verification: { ...sample.verification, tested: undefined } } as never;
    for (let i = 0; i < 4; i++) {
      const out = await host.hooks.fire("verify.judging", "veto", payload, at("vfy-1"));
      expect(out).toMatchObject({ decision: "deny", plugin: "gate-reviewer", failure: null });
      expect(out.reviews?.[0]?.review).toMatchObject({ profile: "reviewer", agentId: null, passed: false, error: expect.stringContaining("review failed") });
    }
    expect(events.filter((e) => e.type === "plugin.hook_failed" || e.type === "plugin.suspended")).toEqual([]);
    expect(host.hooks.suspended("gate-reviewer")).toBe(false);
  });

  test("outside the daemon a verify starts the built-in gates first (§6.1); the daemon's own wait for its host", async () => {
    expect(hooks.listening("verify.judging")).toBe(false);
    await gates();
    expect(hooks.order("verify.judging")).toEqual(["gate-reviewer"]);
    expect(hooks.listening("verify.starting")).toBe(true);
    // Nothing else listens in such a process (no daemon-stream observers, no landing gates).
    for (const h of ["run.changed", "agent.spawning", "merge.landing", "verify.changed"] as const) expect(hooks.listening(h)).toBe(false);
    useHooks(null);
    expect(hooks.listening("verify.judging")).toBe(false);
  });

  test("what the gates leave going is waited for before a CLI exits (settled), bounded", async () => {
    const done: string[] = [];
    inBackground(Bun.sleep(30).then(() => { done.push("stop the reviewer"); inBackground(Bun.sleep(30).then(() => done.push("its follow-up"))); }));
    inBackground(Promise.reject(new Error("a write that failed")));
    await settled();
    expect(done).toEqual(["stop the reviewer", "its follow-up"]);
    inBackground(new Promise(() => {}));   // never settles
    const t = Date.now();
    await settled(100);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

// The live failure (a team-shape eval, 2026-11-05): two verifies failed with "review failed: An internal error occurred"
// while their reviewers were still running; the reviewer's verdict was never asked for, and a verify again passed.
describe("the reviewer gate and its machinery failing (not a verdict)", () => {
  const { reviewerKernel, reviewerInfraFailure, errorText } = gateReviewer;
  const saved = { ...reviewerKernel };
  afterEach(() => { Object.assign(reviewerKernel, saved); delete process.env.CAPCOMD_REVIEW_INFRA_TRIES; });
  const internal = () => Object.assign(new Error("SQLite transaction coordinator is closed."), { group: "sqlite", code: "transaction_closed" });
  /** A kernel whose await fails `fails` times (as an actor that didn't answer), then gives the reviewer's verdict. */
  function fakeKernel(o: { fails: number; error?: () => unknown; verdict?: { passed: boolean; reasons: string[] } }) {
    const calls = { spawn: 0, await: 0 };
    const ops = {
      reviewerSpec: () => ({}),
      getAgentOrThrow: async () => ({ task: "Add a test", result: {} }),
      spawnAgent: async () => { calls.spawn++; return { agentId: "agt-rv" }; },
      awaitAgents: async () => {
        if (++calls.await <= o.fails) throw (o.error ?? internal)();
        return { agents: [{ agentId: "agt-rv", status: "done", result: { verdict: o.verdict ?? { passed: true, reasons: ["fine"] } } }] };
      },
      reviewFits: () => true, cancelAgents: async () => ({}), finishedVerify: async () => false,
    };
    reviewerKernel.ops = (async () => ops) as never;
    reviewerKernel.opOf = async () => ({ branch: "agent/x", agentId: "agt-x", target: "main" });
    return calls;
  }
  async function judged() {
    const b = BUILTINS.find((x) => (x.manifest as { name: string }).name === "gate-reviewer")!;
    const { host } = await hostWith({ source: "builtin", manifest: b.manifest, module: b.module });
    const sample = samplePayload("verify.judging");
    return host.hooks.fire("verify.judging", "veto", { ...sample, reviewer: "reviewer" } as never, at("vfy-infra"));
  }

  test("a call that failed in the engine is tried again, and the reviewer's verdict decides", async () => {
    const calls = fakeKernel({ fails: 1 });
    const out = await judged();
    expect(out).toMatchObject({ decision: "allow" });
    expect(out.reviews?.[0]?.review).toMatchObject({ agentId: "agt-rv", passed: true, reasons: ["fine"] });
    expect(out.reviews?.[0]?.review.retryable).toBeUndefined();
    expect(calls).toEqual({ spawn: 1, await: 2 });
  }, 20_000);

  test("still failing: the deny says the reviewer couldn't be run, with the real error, and is retryable", async () => {
    process.env.CAPCOMD_REVIEW_INFRA_TRIES = "2";
    const calls = fakeKernel({ fails: 99 });
    const out = await judged();
    expect(out).toMatchObject({ decision: "deny", plugin: "gate-reviewer", failure: null, reasons: [] });
    expect((out as { text: string }).text).toContain("not a verdict");
    const review = out.reviews?.[0]?.review;
    expect(review).toMatchObject({ passed: false, retryable: true, error: "the reviewer couldn't be run: SQLite transaction coordinator is closed. (sqlite/transaction_closed)" });
    expect(review?.error).not.toContain("internal error");
    expect(calls.await).toBe(2);
  }, 20_000);

  test("the reviewer's own no, and a refusal, are answers: not tried again, not retryable", async () => {
    let calls = fakeKernel({ fails: 0, verdict: { passed: false, reasons: ["wrong value"] } });
    let out = await judged();
    expect(out).toMatchObject({ decision: "deny", reasons: ["wrong value"] });
    expect(out.reviews?.[0]?.review.retryable).toBeUndefined();
    expect(calls.await).toBe(1);
    const { RelayError } = await import("../../src/core/errors");
    calls = fakeKernel({ fails: 99, error: () => new RelayError("conflict", "the run's budget is spent", "free some budget") });
    out = await judged();
    expect(out.reviews?.[0]?.review).toMatchObject({ error: "review failed: the run's budget is spent" });
    expect(out.reviews?.[0]?.review.retryable).toBeUndefined();
    expect(calls.await).toBe(1);
  }, 20_000);

  test("what counts as the machinery failing", () => {
    expect(reviewerInfraFailure(internal())).toBe(true);
    expect(reviewerInfraFailure(Object.assign(new Error("An internal error occurred"), { group: "rivetkit", code: "internal_error" }))).toBe(true);
    expect(reviewerInfraFailure(new Error("fetch failed: ECONNRESET"))).toBe(true);
    expect(reviewerInfraFailure(Object.assign(new Error("no such profile"), { group: "user", code: "config" }))).toBe(false);
    expect(reviewerInfraFailure(new TypeError("undefined is not an object"))).toBe(false);
    // An actor action's failure as it crosses now (src/utils/actor-errors.ts): a UserError marked internal.
    const crossed = Object.assign(new Error("SQLite transaction coordinator is closed."), { group: "user", code: "internal", metadata: { capcomdInternal: true, group: "sqlite", code: "transaction_closed" } });
    expect(reviewerInfraFailure(crossed)).toBe(true);
    expect(errorText(crossed)).toBe("SQLite transaction coordinator is closed. (sqlite/transaction_closed)");
    expect(errorText(Object.assign(new Error("An internal error occurred"), { group: "rivetkit", code: "internal_error" }))).toBe("An internal error occurred (rivetkit/internal_error)");
  });
});
