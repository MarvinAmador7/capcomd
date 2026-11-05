// merge.landing's `hold{reason, holdId?}` (docs/spec/plugin-api.md §6.6.15): the registry passes a plugin's holdId
// through (and refuses a malformed one), an approved hold is matched by plugin and holdId, else by its reason text, and
// the approval and `capcomd approve` show the hold and the files the merge changes. End to end:
// tests/scenarios/merge-hold.test.ts.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import { HOLD_ID_MAX, type HostEvent } from "../../packages/plugin/src/host/registry";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { samplePayload } from "../../packages/plugin/src/testkit";
import { sameHold } from "../../src/merge/types";
import { mergeApprovalText } from "../../src/api/source";
import { HeldBy } from "../../src/api/legacy-events";
import { heldMergeText } from "../../src/cli/status-text";
import { VERSION } from "../../src/utils/self";

const OPERATOR = { kind: "operator" as const, clientId: null };
const at = (entity: string) => ({ principal: OPERATOR, entity, runId: "run-1" });
const holder = (name: string, answer: unknown): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks: { "merge.landing": {} } } },
  module: { activate: (ctx: PluginContext) => { ctx.hooks.on("merge.landing", () => answer as never); } } as PluginModule<never>,
});
async function hostWith(...c: Candidate[]) {
  const events: HostEvent[] = [];
  const host = new PluginHost({ capcomd: VERSION, kernel: [], emit: (e) => { events.push(e); }, dataDir: (n) => join(tmpdir(), "capcomd-hold-id-test", n) });
  await host.start(c);
  return { host, events };
}

describe("a hold's holdId in the registry", () => {
  test("is passed through on the outcome and, asking everyone, on each veto", async () => {
    const { host } = await hostWith(holder("a-named", { decision: "hold", reason: "3 open comments", holdId: "review-comments" }), holder("b-plain", { decision: "hold", reason: "a person looks" }));
    expect(await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toEqual({ decision: "hold", plugin: "a-named", text: "3 open comments", holdId: "review-comments" });
    const all = await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), { ...at("mrg-1"), askAll: true });
    expect(all.vetoes).toEqual([{ plugin: "a-named", decision: "hold", text: "3 open comments", holdId: "review-comments" }, { plugin: "b-plain", decision: "hold", text: "a person looks" }]);
  });

  test.each([[""], [42], ["x".repeat(HOLD_ID_MAX + 1)]])("a malformed holdId (%p) is an invalid result, which fails the gate closed", async (holdId) => {
    const { host, events } = await hostWith(holder("bad-id", { decision: "hold", reason: "look", holdId }));
    expect(await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toMatchObject({ decision: "deny", plugin: "bad-id", failure: "invalid_result" });
    expect(events.filter((e) => e.type === "plugin.hook_failed").map((e) => (e.data as { message: string }).message)).toEqual([`a hold's holdId is a non-empty string of at most ${HOLD_ID_MAX} characters`]);
  });

  test("the longest allowed holdId is accepted", async () => {
    const { host } = await hostWith(holder("long-id", { decision: "hold", reason: "look", holdId: "x".repeat(HOLD_ID_MAX) }));
    expect(await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toMatchObject({ decision: "hold", holdId: "x".repeat(HOLD_ID_MAX) });
  });
});

describe("which approved hold satisfies a hold (sameHold)", () => {
  test("named: the same plugin and holdId, whatever the reason; unnamed: the same reason; never one for the other", () => {
    const named = { plugin: "p", reason: "3 open comments", holdId: "review" };
    expect(sameHold(named, { plugin: "p", text: "5 open comments", holdId: "review" })).toBe(true);
    expect(sameHold(named, { plugin: "p", text: "3 open comments", holdId: "other" })).toBe(false);
    expect(sameHold(named, { plugin: "q", text: "3 open comments", holdId: "review" })).toBe(false);
    expect(sameHold(named, { plugin: "p", text: "3 open comments" })).toBe(false);
    const plain = { plugin: "p", reason: "a person looks" };
    expect(sameHold(plain, { plugin: "p", text: "a person looks" })).toBe(true);
    expect(sameHold(plain, { plugin: "p", text: "a person looks again" })).toBe(false);
    expect(sameHold(plain, { plugin: "p", text: "a person looks", holdId: "x" })).toBe(false);
    expect(sameHold(plain, { plugin: "q", text: "a person looks" })).toBe(false);
  });
});

describe("what the person deciding sees", () => {
  const diff = { files: [{ path: "src/a.ts", status: "modified", added: 3, removed: 1 }, { path: "README.md", status: "modified", added: 1, removed: 0 }], filesTotal: 7, added: 9, removed: 2 };
  test("the approval's subject carries the holdId and the files (harness.v1 HeldBy takes holdId)", () => {
    const a = mergeApprovalText({ ref: "agt-1", branch: "capcomd/run-1/agt-1", target: "trunk", diff, heldBy: { plugin: "p", reason: "5 open comments", holdId: "review" } });
    expect(a.subject).toMatchObject({ target: "trunk", heldBy: { plugin: "p", reason: "5 open comments", holdId: "review" }, files: diff.files, filesTotal: 7 });
    expect(mergeApprovalText({ heldBy: { plugin: "p", reason: "r" } }).subject.heldBy).toEqual({ plugin: "p", reason: "r" });
    expect(HeldBy.parse({ plugin: "p", reason: "r", holdId: "review" })).toEqual({ plugin: "p", reason: "r", holdId: "review" });
  });
  test("capcomd merge / approve name the plugin, its reason, the files and how to approve", () => {
    expect(heldMergeText("run-1", "mrg-1", { heldBy: { plugin: "p", reason: "5 open comments" }, diff }, { again: true, max: 1 })).toEqual([
      "  held by the p plugin: 5 open comments",
      "  changes 7 file(s), +9 -2: src/a.ts, and 6 more",
      "  approve it again to land it: capcomd approve run-1 mrg-1",
    ]);
    expect(heldMergeText("run-1", "mrg-1", { heldBy: { plugin: "p", reason: "r" }, diff: { ...diff, filesTotal: 2 } })[1]).toBe("  changes 2 file(s), +9 -2: src/a.ts, README.md");
    expect(heldMergeText("run-1", "mrg-1", { heldBy: { plugin: "p", reason: "r" } })).toEqual(["  held by the p plugin: r", "  approve it to land it: capcomd approve run-1 mrg-1"]);
  });
});
