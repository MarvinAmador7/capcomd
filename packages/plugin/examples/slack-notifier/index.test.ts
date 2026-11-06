// The Slack example's own tests, as its author would write them with the test kit: what it says for each hook payload
// (`render`), and its main loop against a stand-in client and a local webhook, no daemon. The same plugin against a
// real daemon on the fake sandbox is tests/scenarios/plugin-slack-example.test.ts (`testkit.bootWith`).
import { afterAll, describe, expect, test } from "bun:test";
import type { EmitBody, HookFrame, HookName, HookPayload, PluginClient, ProcessEnvironment, SessionOpen, WireHookCall } from "@capcomd/plugin";
import { samplePayload, testkit } from "@capcomd/plugin/testkit";
import { main, render } from "./index";

const cfg = { channel: "#ci", quiet: false };
/** A hook call as the stream carries it (no AbortSignal: its deadline is the signal). */
const wire = <N extends HookName>(hook: N, payload: HookPayload<N>): WireHookCall => {
  const { signal: _s, ...call } = testkit.call(hook, payload);
  return call as WireHookCall;
};
const run = samplePayload("run.changed").run, agent = samplePayload("agent.changed").agent, merge = samplePayload("merge.changed").merge;

describe("render: it speaks on failures, attention and landed work (spec §16.5)", () => {
  test("a run's start (not when quiet) and its end, with the reason as plain text", () => {
    expect(render(wire("run.changed", { run, change: { kind: "started" } }), cfg)).toBe(`Run ${run.id} started.`);
    expect(render(wire("run.changed", { run, change: { kind: "started" } }), { ...cfg, quiet: true })).toBeNull();
    expect(render(wire("run.changed", { run, change: { kind: "ended", state: "failed", reason: "budget <!channel> & more" } }), cfg))
      .toBe(`Run ${run.id} failed: budget &lt;!channel&gt; &amp; more.`);
    expect(render(wire("run.changed", { run, change: { kind: "paused", by: "operator" } }), cfg)).toBeNull();
  });
  test("an agent that failed or needs attention; one that finished or idles is quiet", () => {
    expect(render(wire("agent.changed", { agent, change: { kind: "ended", status: "failed", result: null } }), cfg)).toBe(`Agent ${agent.id} (worker) failed in run ${agent.runId}.`);
    expect(render(wire("agent.changed", { agent, change: { kind: "ended", status: "done", result: null } }), cfg)).toBeNull();
    const notice = (kind: "stalled" | "idle") => ({ kind, detail: { text: "x", untrusted: true as const, by: agent.id }, at: "2026-11-04T12:00:00.000Z" });
    expect(render(wire("agent.changed", { agent, change: { kind: "notice", notice: notice("stalled") } }), cfg)).toBe(`Agent ${agent.id} needs attention: stalled.`);
    expect(render(wire("agent.changed", { agent, change: { kind: "notice", notice: notice("idle") } }), cfg)).toBeNull();
  });
  test("landed work, with a bypassed veto said; a failed merge with its reason", () => {
    expect(render(wire("merge.changed", { merge, change: { kind: "landed", sha: "0123456789abcdef", pr: 12, bypassedVetoes: [{ plugin: "scanner", reason: "x" }] } }), cfg))
      .toBe(`Landed ${merge.ref} into ${merge.target} (0123456, PR #12) with 1 plugin veto(es) bypassed by the operator.`);
    expect(render(wire("merge.changed", { merge, change: { kind: "failed", reason: "<https://evil|click>" } }), cfg)).toBe(`Merge of ${merge.ref} into ${merge.target} failed: &lt;https://evil|click&gt;.`);
    expect(render(wire("merge.changed", { merge, change: { kind: "requested" } }), cfg)).toBeNull();
  });
});

describe("main: the handshake, the stream, the post and the event", () => {
  const posts: unknown[] = [];
  const slack = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { posts.push(await req.json()); return new Response("ok"); } });
  afterAll(() => slack.stop(true));
  const env = { CAPCOMD_PLUGIN_NAME: "slack-notifier", CAPCOMD_PLUGIN_ROOT: import.meta.dir, CAPCOMD_PLUGIN_SESSION: "ses_test", CAPCOMD_PLUGIN_SOCKET: "/nonexistent", CAPCOMD_PLUGIN_TOKEN: "cch_test", CAPCOMD_PLUGIN_DATA: "/nonexistent", CAPCOMD_PLUGIN_PROTOCOL: "1" } as ProcessEnvironment;

  /** A PluginClient that answers the handshake and plays `frames`; what the plugin sent is kept. */
  function stand(frames: HookFrame[], secrets: Record<string, string>) {
    const sent = { open: [] as SessionOpen[], emit: [] as EmitBody[] };
    const client: PluginClient = {
      async open(b) { sent.open.push(b); return { session: b.session, protocol: 1, plugin: { name: "slack-notifier", version: "1.0.0", scopes: ["read", "steer"] }, config: { channel: "#ci", quiet: false }, secrets, hookTimeoutsMs: {}, connectWithinMs: 30_000, daemon: { version: "0.9.0", capabilities: [] } }; },
      async *hooks() { yield* frames; },
      async answer() { throw new Error("observe calls take no answer"); },
      async emit(b) { sent.emit.push(b); return { seq: sent.emit.length }; },
      storage: { get: async () => null, put: async () => { throw new Error("unused"); }, delete: async () => {}, list: async () => [] },
      fetch: async () => new Response(null, { status: 404 }),
    };
    return { client, sent };
  }

  test("opens with its session, manifest hash and declared hooks; posts within the deadline; emits posted", async () => {
    const { client, sent } = stand([
      { frame: "hook.call", seq: 1, call: { ...wire("run.changed", { run, change: { kind: "started" } }), runId: run.id } },
      { frame: "hook.call", seq: 2, call: wire("agent.changed", { agent, change: { kind: "ended", status: "done", result: null } }) },
      { frame: "hook.call", seq: 3, call: { ...wire("run.changed", { run, change: { kind: "started" } }), deadline: new Date(Date.now() - 1000).toISOString() } },
      { frame: "session.closing", seq: 4, reason: "daemon_stopping" },
    ], { webhook: `http://127.0.0.1:${slack.port}/hook` });
    await main(client, env, new AbortController().signal);
    expect(sent.open).toEqual([{ session: "ses_test", protocol: 1, manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/), pid: process.pid, hooks: ["run.changed", "agent.changed", "merge.changed"] }]);
    // One post: the finished agent is quiet, and a call past its deadline is not worth posting.
    expect(posts).toEqual([{ channel: "#ci", text: `Run ${run.id} started.` }]);
    expect(sent.emit).toEqual([{ type: "posted", stream: run.id, entity: run.id, text: "Posted to Slack.", data: { hook: "run.changed", channel: "#ci" } }]);
  });

  test("without its webhook secret it refuses to run", async () => {
    const { client } = stand([], {});
    await expect(main(client, env, new AbortController().signal)).rejects.toThrow(/webhook secret is not configured/);
  });
});
