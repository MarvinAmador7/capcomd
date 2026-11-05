// The gates (docs/spec/plugin-api.md §17.2 step 5): a judge's review report (§6.6.13) and the operator's ask-everyone
// fire (§6.5) in the registry, the built-in reviewer gate's manifest and its answer with no reviewer, and the gates a
// process that isn't the daemon starts for its verifies (§6.1). The kernel's side end to end: tests/scenarios/gates.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { HostEvent } from "../../packages/plugin/src/host/registry";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { samplePayload } from "../../packages/plugin/src/testkit";
import { BUILTINS } from "../../src/plugins/builtins";
import { gates, hooks, useHooks } from "../../src/plugins/hooks";
import { VERSION } from "../../src/utils/self";

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
});
