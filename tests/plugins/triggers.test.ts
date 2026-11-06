// The trigger intake without an engine (docs/spec/plugin-api.md §16.3, src/triggers/intake.ts): its order (dedupe, a
// followed thread, the kernel's gate, trigger.admitting, the accept mode, act), the operator's settings read again for
// each trigger, subscriptions and how they end, a start that fails, the records `capcomd triggers log` reads, ctx.triggers
// on the daemon's host only, and the two built-in sources: schedules (source-schedule, on its timers) and GitHub comments
// (forge-github). Runs start and messages go through injected stand-ins here; tests/scenarios/triggers.test.ts has the
// real ones.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "../../packages/plugin/src/host/host";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { HookCall } from "../../packages/plugin/src/hooks";
import type { Principal, Trigger } from "../../packages/plugin/src/shapes";
import { PluginError } from "../../packages/plugin/src/errors";
import { CreateRunError } from "../../src/api/source";
import { resetJobs, useDaemonEvents } from "../../src/jobs/service";
import { configured, kernelHost } from "../../src/plugins/host";
import { useHooks } from "../../src/plugins/hooks";
import { pluginStorage } from "../../src/plugins/storage";
import { checkSchedule, fireTrigger, manifest as scheduleManifest, plugin as schedulePlugin } from "../../src/plugins/sources/schedule";
import { commentTrigger, pollGitHub } from "../../src/plugins/forges/github-source";
import type { IssueComment } from "../../src/plugins/forges/github-rest";
import { admit, gateOf, listSubscriptionRecords, readTriggerLog, resetTriggers, subscribe, subscriptions, sweepTriggers, threadMatches, triggerMessage, triggerOfRun, triggersConfig, useIntakeDeps, useTriggerEvents, type RunStanding } from "../../src/triggers/intake";
import { capcomd } from "../helpers/engine";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOURCE: Principal = { kind: "plugin", name: "test-source", scopes: ["steer"] };
let home: string, settings: string;
let events: Array<{ type: string; entity: string; text: string; data: Record<string, unknown> }>;
let started: Array<{ goal: string; repo?: string; principal: Principal }>;
let delivered: Array<{ runId: string; from: string; body: string; key: string }>;
let standing: Record<string, RunStanding>;
const savedHome = process.env.CAPCOMD_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "capcomd-triggers-"));
  process.env.CAPCOMD_HOME = home;
  settings = join(home, "triggers.json");
  process.env.CAPCOMD_TRIGGERS_FILE = settings;
  setGate({});
  events = []; started = []; delivered = []; standing = {};
  useTriggerEvents((e) => { events.push(e); });
  let n = 0;
  useIntakeDeps({
    startRun: async (input, principal) => { started.push({ ...input, principal }); return { runId: `run-started${++n}` }; },
    deliver: async (runId, m) => { delivered.push({ runId, ...m }); return { seq: delivered.length }; },
    standing: async (runId) => standing[runId] ?? { exists: true, live: true, endedAt: null, stopped: false },
  });
});
afterEach(() => {
  resetTriggers(); resetJobs(); useHooks(null); useDaemonEvents(null);
  delete process.env.CAPCOMD_TRIGGERS_FILE;
  process.env.CAPCOMD_HOME = savedHome;
});

function setGate(sources: Record<string, unknown>) { writeFileSync(settings, JSON.stringify({ sources })); }
let ids = 0;
function trigger(o: Partial<Omit<Trigger, "actor">> & { actor?: Partial<Trigger["actor"]> } = {}): Trigger {
  const { actor, ...rest } = o;
  return {
    source: "test", id: `t-${++ids}`, thread: "issue/1", at: new Date().toISOString(),
    actor: { id: "alice", display: "Alice", bot: false, ...actor }, addressed: "mention",
    text: { text: "please fix the flaky test", untrusted: true, by: "test" }, replyTo: null, data: {}, ...rest,
  };
}

describe("the gate's settings", () => {
  test("a thread pattern's * matches any run of characters; anything else is exact", () => {
    expect(threadMatches("acme/app#*", "acme/app#12")).toBe(true);
    expect(threadMatches("acme/app#*", "acme/other#12")).toBe(false);
    expect(threadMatches("issue/1", "issue/1")).toBe(true);
    expect(threadMatches("issue/1", "issue/10")).toBe(false);
    expect(threadMatches("a.b*", "axb")).toBe(false);
  });

  test("a source with no settings records (observe), allows nobody; a bad mode is observe; CAPCOMD_TRIGGERS_FILE wins", () => {
    expect(gateOf({}, "github")).toEqual({ allowed: [], opened: [], mode: "observe", project: null });
    expect(gateOf({ sources: { github: { allowed: ["alice", 3] as never, mode: "yolo" as never, project: " /src/app " } } }, "github")).toEqual({ allowed: ["alice"], opened: [], mode: "observe", project: "/src/app" });
    setGate({ test: { mode: "auto" } });
    expect(triggersConfig()).toEqual({ sources: { test: { mode: "auto" } } });
    expect(triggersConfig({ CAPCOMD_NO_CONFIG: "1", CAPCOMD_HOME: home })).toEqual({});
  });
});

describe("the intake decides in order and records each decision", () => {
  test("not allowed: denied by the allowlist, nothing runs; the same trigger again is deduped", async () => {
    const t = trigger({ actor: { id: "mallory" } });
    expect(await admit(t, SOURCE)).toMatchObject({ kind: "denied", by: "allowlist" });
    const again = await admit(t, SOURCE);
    expect(again.kind).toBe("deduped");
    expect(started).toEqual([]);
    expect(readTriggerLog().map((e) => e.decision.kind)).toEqual(["denied", "deduped"]);
    expect(events.map((e) => [e.type, e.data.decision])).toEqual([["trigger.received", "denied"], ["trigger.received", "deduped"]]);
    expect(events[0]!.entity).toMatch(/^trigger:test\//);
    expect(events[0]!.text).toBe("A trigger from test was denied.");
  });

  test("allowed and addressed is explicit: a run starts in every mode, with the text as its goal, following the thread", async () => {
    setGate({ test: { allowed: ["alice"], mode: "off", project: "/src/app" } });
    const d = await admit(trigger({ thread: "issue/7" }), SOURCE);
    expect(d).toEqual({ kind: "started", runId: "run-started1" });
    expect(started).toEqual([{ goal: "please fix the flaky test", repo: "/src/app", principal: SOURCE }]);
    expect(triggerOfRun("run-started1")).toMatchObject({ source: "test", thread: "issue/7", actor: { id: "alice", display: "Alice", bot: false } });
    expect(listSubscriptionRecords()).toEqual([{ runId: "run-started1", source: "test", thread: "issue/7", until: null }]);
    expect(events.map((e) => e.type)).toEqual(["trigger.subscribed", "trigger.received"]);
    expect(events[0]!.data).toEqual({ source: "test", thread: "issue/7", runId: "run-started1", until: null });
    expect(readTriggerLog()[0]).toMatchObject({ source: "test", thread: "issue/7", actor: { id: "alice" }, text: "please fix the flaky test", decision: { kind: "started" }, gate: { allowed: true, strength: "explicit", mode: "off" } });
  });

  test("inferred (allowed, not addressed): off denies, observe records what would have run, auto runs it; an opened thread lets anyone in", async () => {
    setGate({ test: { allowed: ["alice"], mode: "off" } });
    expect(await admit(trigger({ addressed: null }), SOURCE)).toMatchObject({ kind: "denied", by: "mode" });
    setGate({ test: { allowed: ["alice"] } });
    expect(await admit(trigger({ addressed: null }), SOURCE)).toEqual({ kind: "recorded", wouldHave: "start", runId: null });
    expect(started).toEqual([]);
    // The settings are read again for each trigger: the next one runs.
    setGate({ test: { opened: ["issue/*"], mode: "auto" } });
    expect(await admit(trigger({ addressed: null, actor: { id: "bob" }, thread: "issue/3" }), SOURCE)).toMatchObject({ kind: "started" });
    expect(started).toHaveLength(1);
  });

  test("a thread a run follows: a person's trigger reaches its planner with no gate; a bot's reaches only a live run", async () => {
    await subscribe({ runId: "run-live", source: "test", thread: "pr/9" }, "plugin:test-source");
    const d = await admit(trigger({ thread: "pr/9", actor: { id: "carol", display: "Carol" }, addressed: null, replyTo: "https://example.test/pr/9#c1" }), SOURCE);
    expect(d).toEqual({ kind: "continued", runId: "run-live", seq: 1 });
    expect(delivered[0]).toMatchObject({ runId: "run-live", from: "trigger:test" });
    expect(delivered[0]!.body).toBe("Carol (carol) wrote on pr/9:\n\nplease fix the flaky test\n\n(A reply goes to https://example.test/pr/9#c1.)");
    // A bot on a live run's thread: context for it.
    expect(await admit(trigger({ thread: "pr/9", actor: { id: "ci", bot: true }, addressed: null }), SOURCE)).toMatchObject({ kind: "continued" });
    // The run ended (it still follows the thread for 14 days): a person still reaches it, a bot is gated like any trigger.
    standing["run-live"] = { exists: true, live: false, endedAt: Date.now() - 60_000, stopped: false };
    expect(await admit(trigger({ thread: "pr/9", actor: { id: "ci", bot: true } }), SOURCE)).toMatchObject({ kind: "denied", by: "allowlist" });
    expect(await admit(trigger({ thread: "pr/9", actor: { id: "dave" } }), SOURCE)).toMatchObject({ kind: "continued", runId: "run-live" });
    expect(delivered).toHaveLength(3);
  });

  test("a start that fails is no decision: the emit says why, it is logged failed, and the trigger can come again", async () => {
    setGate({ test: { allowed: ["alice"] } });
    useIntakeDeps({ startRun: async () => { throw new CreateRunError("repo is required: this daemon has no default repository"); }, standing: async () => ({ exists: true, live: true, endedAt: null, stopped: false }) });
    const t = trigger();
    await expect(admit(t, SOURCE)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("no default repository") });
    expect(readTriggerLog().at(-1)!.decision).toMatchObject({ kind: "failed" });
    expect(events.at(-1)!.data.decision).toBe("failed");
    await expect(admit(t, SOURCE)).rejects.toMatchObject({ code: "invalid" });
  });

  test("a malformed trigger is refused before anything is recorded; text may be a plain string", async () => {
    await expect(admit({ ...trigger(), actor: { id: "x" } } as never, SOURCE)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("actor") });
    await expect(admit({ ...trigger(), addressed: "loudly" } as never, SOURCE)).rejects.toMatchObject({ code: "invalid" });
    await expect(admit({ ...trigger(), at: "yesterday" }, SOURCE)).rejects.toMatchObject({ code: "invalid" });
    expect(readTriggerLog()).toEqual([]);
    setGate({ test: { allowed: ["alice"] } });
    await admit({ ...trigger(), text: "run the nightly report" as never }, SOURCE);
    expect(started[0]!.goal).toBe("run the nightly report");
  });

  test("the planner reads who wrote it and where; a secret in the text is not in the log", async () => {
    expect(triggerMessage(trigger({ actor: { id: "ci", display: "ci", bot: true } }))).toBe("ci, a bot, wrote on issue/1:\n\nplease fix the flaky test");
    await admit(trigger({ actor: { id: "mallory" }, text: { text: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here", untrusted: true, by: "x" } }), SOURCE);
    expect(readTriggerLog()[0]!.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("subscriptions end (§16.3.5)", () => {
  test("at their own until; at once when a person stops the run; 14 days after the run ends; idempotent", async () => {
    const soon = new Date(Date.now() + 300).toISOString();
    expect(await subscribe({ runId: "run-a", source: "test", thread: "t/1", until: soon }, "plugin:x")).toEqual({ runId: "run-a", source: "test", thread: "t/1", until: soon });
    expect(await subscribe({ runId: "run-a", source: "test", thread: "t/1", until: soon }, "plugin:x")).toMatchObject({ until: soon });
    await subscribe({ runId: "run-b", source: "test", thread: "t/2" }, "intake");
    await subscribe({ runId: "run-c", source: "test", thread: "t/3" }, "intake");
    expect(events.filter((e) => e.type === "trigger.subscribed")).toHaveLength(3);
    await sleep(400);
    standing["run-b"] = { exists: true, live: false, endedAt: Date.now(), stopped: true };
    standing["run-c"] = { exists: true, live: false, endedAt: Date.now() - 15 * 24 * 3_600_000, stopped: false };
    await sweepTriggers();
    expect(events.filter((e) => e.type === "trigger.unsubscribed").map((e) => [e.data.runId, e.data.cause])).toEqual(expect.arrayContaining([["run-a", "expired"], ["run-b", "stopped"], ["run-c", "expired"]]));
    expect(await subscriptions()).toEqual([]);
    // After it ended, the thread is gated like any other.
    expect(await admit(trigger({ thread: "t/1", actor: { id: "zed" } }), SOURCE)).toMatchObject({ kind: "denied" });
  });

  test("an ended run's subscription says until when (14 days after the end); a run that doesn't exist can't subscribe", async () => {
    await subscribe({ runId: "run-d", source: "test", thread: "t/4" }, "intake");
    const end = Date.now() - 1000;
    standing["run-d"] = { exists: true, live: false, endedAt: end, stopped: false };
    expect(await subscriptions({ runId: "run-d" })).toEqual([{ runId: "run-d", source: "test", thread: "t/4", until: new Date(end + 14 * 24 * 3_600_000).toISOString() }]);
    standing["run-nope"] = { exists: false, live: false, endedAt: null, stopped: false };
    await expect(subscribe({ runId: "run-nope", source: "test", thread: "t/5" }, "x")).rejects.toMatchObject({ code: "not_found" });
  });
});

/** A plugin that contributes the `test` source, answers trigger.admitting by `deny` in the trigger's data, hands out its context. */
function sourcePlugin(heard: HookCall[], got: (ctx: PluginContext) => void): Candidate {
  return {
    source: "builtin",
    manifest: { schema: "capcomd.plugin/v1", name: "test-source", version: "1.0.0", description: "A test source.", apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" },
      provides: ["source:test"], scopes: ["read", "steer"], contributes: { sources: [{ name: "test", summary: "tests" }], hooks: { "trigger.admitting": {}, "trigger.changed": {} } } },
    module: { activate(ctx) {
      got(ctx);
      ctx.hooks.on("trigger.admitting", (call) => { heard.push(call as HookCall); return call.payload.trigger.data.deny ? { decision: "deny", reason: "no triggers from forks" } : { decision: "allow" }; });
      ctx.hooks.on("trigger.changed", (call) => { heard.push(call as HookCall); });
    } } as PluginModule<never>,
  };
}

describe("ctx.triggers and the trigger hooks", () => {
  test("a plugin denies at trigger.admitting what the gate allowed; trigger.changed tells each decision; emit names a contributed source", async () => {
    setGate({ test: { allowed: ["alice"] } });
    const heard: HookCall[] = [];
    let ctx!: PluginContext;
    const host = kernelHost({ log: false, jobs: true, triggers: true });
    useHooks(host.hooks);
    await host.start([sourcePlugin(heard, (c) => { ctx = c; })]);
    expect(await ctx.triggers.emit(trigger({ data: { deny: true } }))).toEqual({ kind: "denied", by: "plugin", reason: "the test-source plugin: no triggers from forks" });
    expect(await ctx.triggers.emit(trigger({ actor: { id: "mallory" } }))).toMatchObject({ kind: "denied", by: "allowlist" });
    expect(await ctx.triggers.emit(trigger())).toMatchObject({ kind: "started" });
    await host.hooks.idle();
    const admitting = heard.filter((c) => c.hook === "trigger.admitting");
    // Asked only about what the gate allowed: the allowlist's denial reached no plugin.
    expect(admitting.map((c) => (c.payload as { gate: unknown }).gate)).toEqual([{ allowed: true, strength: "explicit", mode: "observe", subscribed: null }, { allowed: true, strength: "explicit", mode: "observe", subscribed: null }]);
    expect(admitting[0]!.principal).toEqual({ kind: "plugin", name: "test-source", scopes: ["read", "steer"] });
    expect(heard.filter((c) => c.hook === "trigger.changed").map((c) => (c.payload as { decision: { kind: string } }).decision.kind)).toEqual(["denied", "denied", "started"]);
    await expect(ctx.triggers.emit(trigger({ source: "slack" }))).rejects.toMatchObject({ code: "forbidden" });
    expect(await ctx.triggers.subscribe({ runId: "run-x", source: "test", thread: "chat/1" })).toEqual({ runId: "run-x", source: "test", thread: "chat/1", until: null });
    expect((await ctx.triggers.subscriptions({ runId: "run-x" })).map((s) => s.thread)).toEqual(["chat/1"]);
    await ctx.triggers.unsubscribe({ runId: "run-x", source: "test", thread: "chat/1" });
    expect(events.at(-1)).toMatchObject({ type: "trigger.unsubscribed", data: { cause: "unsubscribed" } });
    await host.stop();
  });

  test("outside the daemon a plugin has no triggers: unsupported", async () => {
    let ctx!: PluginContext;
    const host = kernelHost({ log: false });
    await host.start([sourcePlugin([], (c) => { ctx = c; })]);
    await expect(ctx.triggers.emit(trigger())).rejects.toMatchObject({ code: "unsupported" });
    await host.stop();
  });

  test("capcomd triggers log and subscriptions read the records on this machine", async () => {
    setGate({ test: { allowed: ["alice"] } });
    await admit(trigger({ actor: { id: "mallory" } }), SOURCE);
    await admit(trigger({ thread: "issue/5" }), SOURCE);
    const env = { CAPCOMD_HOME: home };
    const j = JSON.parse((await capcomd(["triggers", "log", "--json"], env)).stdout);
    expect(j.triggers.map((e: { decision: { kind: string } }) => e.decision.kind)).toEqual(["denied", "started"]);
    const text = (await capcomd(["triggers", "log", "--limit", "1"], env)).stdout;
    expect(text).toMatch(/test {2}alice {2}issue\/5 {2}started run-started1\n$/);
    expect((await capcomd(["triggers", "log", "--source", "github"], env)).stdout).toBe("No trigger from github yet.\n");
    const subs = JSON.parse((await capcomd(["triggers", "subscriptions", "--json"], env)).stdout);
    expect(subs.subscriptions).toEqual([{ runId: "run-started1", source: "test", thread: "issue/5", until: null }]);
  }, 30_000);
});

describe("the schedule source (source-schedule)", () => {
  test("a schedule is checked; a fire is a trigger of its own thread, from the schedule's actor, addressed to capcomd", () => {
    expect(checkSchedule("nightly", { text: "update deps", everyMs: 86_400_000 })).toEqual({ ok: true, schedule: { text: "update deps", everyMs: 86_400_000 } });
    expect(checkSchedule("Nightly", { text: "x", everyMs: 1000 })).toMatchObject({ ok: false });
    expect(checkSchedule("n", { text: "x" })).toEqual({ ok: false, why: "it needs at (once) or everyMs (on an interval)" });
    expect(checkSchedule("n", { text: "x", everyMs: 10 })).toMatchObject({ ok: false });
    expect(fireTrigger("nightly", { text: "update deps", everyMs: 1000 }, { jobId: "job-k1", n: 3, at: "2026-11-06T02:00:00.000Z" })).toEqual({
      source: "schedule", id: "nightly/job-k1/3", thread: "schedule:nightly@2026-11-06T02:00:00.000Z", at: "2026-11-06T02:00:00.000Z",
      actor: { id: "schedule:nightly", display: "the nightly schedule", bot: true }, addressed: "direct",
      text: { text: "update deps", untrusted: true, by: "operator" }, replyTo: null, data: { schedule: "nightly", fire: 3 },
    });
  });

  test("each schedule is a timer of the plugin; its fire starts a run when the operator allows the schedule; a changed schedule's old timer stops", async () => {
    setGate({ schedule: { allowed: ["schedule:nightly"] } });
    const start = async (schedules: Record<string, unknown>) => {
      const host = kernelHost({ log: false, jobs: true, triggers: true });
      useHooks(host.hooks);
      await host.start([configured({ source: "builtin", manifest: scheduleManifest, module: schedulePlugin as Candidate["module"] }, { CAPCOMD_PLUGIN_SOURCE_SCHEDULE_SCHEDULES: JSON.stringify(schedules), CAPCOMD_NO_CONFIG: "1" })]);
      expect(host.get("source-schedule")?.state).toBe("active");
      return host;
    };
    const timers = () => readdirSync(join(home, "state", "jobs")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(home, "state", "jobs", f), "utf8")));
    let host = await start({ nightly: { text: "update the dependencies", at: new Date(Date.now() + 200).toISOString() }, "Bad Name": { text: "x", everyMs: 1000 } });
    for (let i = 0; i < 100 && !started.length; i++) await sleep(50);
    expect(started).toEqual([{ goal: "update the dependencies", principal: { kind: "plugin", name: "source-schedule", scopes: ["read", "steer"] } }]);
    expect(readTriggerLog()[0]).toMatchObject({ source: "schedule", actor: { id: "schedule:nightly", bot: true }, addressed: "direct", decision: { kind: "started" } });
    expect(readTriggerLog()[0]!.thread).toMatch(/^schedule:nightly@/);
    expect(timers().map((t) => t.spec.label)).toEqual(["schedule nightly"]);
    await host.stop();
    resetJobs();
    // Changed: a new timer; the old one (an hourly one now) is cancelled.
    host = await start({ nightly: { text: "update the dependencies", everyMs: 3_600_000 } });
    for (let i = 0; i < 100 && timers().filter((t) => t.state === "running").length !== 1; i++) await sleep(50);
    expect(timers().filter((t) => t.state === "running").map((t) => t.spec.everyMs)).toEqual([3_600_000]);
    await host.stop();
    resetJobs();
    host = await start({});
    for (let i = 0; i < 100 && timers().some((t) => t.state === "running"); i++) await sleep(50);
    expect(timers().filter((t) => t.state === "running")).toEqual([]);
    await host.stop();
  }, 30_000);
});

describe("the GitHub source (forge-github)", () => {
  const comment = (id: number, o: Partial<IssueComment> = {}): IssueComment => ({
    id, body: "looks good", user: { login: "alice", type: "User" }, html_url: `https://github.com/acme/app/pull/12#issuecomment-${id}`,
    issue_url: "https://api.github.com/repos/acme/app/issues/12", created_at: "2026-11-06T10:00:00Z", updated_at: "2026-11-06T10:00:00Z", ...o,
  });

  test("a comment is a trigger on its issue's thread; the command word or a mention of the login addresses capcomd; what capcomd wrote is dropped", () => {
    expect(commentTrigger("acme/app", comment(5, { body: "@capcomd-bot please rebase" }), "capcomd-bot")).toEqual({
      source: "github", id: "comment-5", thread: "acme/app#12", at: "2026-11-06T10:00:00Z", actor: { id: "alice", display: "alice", bot: false }, addressed: "mention",
      text: { text: "@capcomd-bot please rebase", untrusted: true, by: "github:alice" }, replyTo: "https://github.com/acme/app/pull/12#issuecomment-5",
      data: { repo: "acme/app", number: 12, commentId: 5, url: "https://github.com/acme/app/pull/12#issuecomment-5", pullRequest: true },
    });
    // The login is usually the user's own: their comments are theirs, addressed by the command word.
    expect(commentTrigger("acme/app", comment(6, { user: { login: "marvin" }, body: "thanks!\n/capcomd fix the failing test" }), "marvin")).toMatchObject({ actor: { id: "marvin" }, addressed: "mention" });
    expect(commentTrigger("acme/app", comment(6, { user: { login: "marvin" }, body: "note to self @marvin" }), "marvin")!.addressed).toBeNull();
    expect(commentTrigger("acme/app", comment(6, { body: "/capcomdx no" }), "marvin")!.addressed).toBeNull();
    expect(commentTrigger("acme/app", comment(6, { body: "!go now" }), "marvin", "!go")!.addressed).toBe("mention");
    expect(commentTrigger("acme/app", comment(6, { body: "Done.\n\n<!-- capcomd -->" }), "marvin")).toBeNull();
    expect(commentTrigger("acme/app", comment(7, { body: "email me at x@capcomd-bot.dev" }), "capcomd-bot")!.addressed).toBeNull();
    expect(commentTrigger("acme/app", comment(8, { user: { login: "dependabot[bot]", type: "Bot" } }), "capcomd-bot")!.actor.bot).toBe(true);
  });

  test("the first poll marks where it starts; later ones emit new comments in order, from where they left off", async () => {
    const emitted: Trigger[] = [];
    const store = pluginStorage(join(home, "plugins", "forge-github"));
    const ctx = { storage: store, log: { warn: () => {} }, triggers: { emit: async (t: Trigger) => { emitted.push(t); return { kind: "recorded" }; }, subscriptions: async () => [{ runId: "run-1", source: "github", thread: "acme/other#3", until: null }] } } as unknown as PluginContext<unknown>;
    const asked: Array<[string, string]> = [];
    let page: IssueComment[] = [];
    const api = { listIssueComments: async (repo: string, since: string) => { asked.push([repo, since]); return repo === "acme/app" ? page : []; }, viewer: async () => "capcomd-bot" } as never;
    const cfg = { api: "https://api.github.com", sourceRepos: ["acme/app"], sourceEveryMs: 60_000, sourceCommand: "/capcomd" };
    expect(await pollGitHub(ctx, cfg, api)).toBe(0);
    expect(asked).toEqual([]);
    const start = ((await store.get("daemon", "github/acme/app")) as { since: string }).since;
    // Its followed thread's repository is read too.
    expect(await store.get("daemon", "github/acme/other")).toBeDefined();
    const later = new Date(Date.parse(start) + 60_000).toISOString(), latest = new Date(Date.parse(start) + 120_000).toISOString();
    page = [comment(1, { created_at: "2020-01-01T00:00:00Z", updated_at: later }), comment(2, { created_at: later, updated_at: later }), comment(3, { created_at: latest, updated_at: latest, body: "Merged.\n<!-- capcomd -->" })];
    expect(await pollGitHub(ctx, cfg, api)).toBe(1);
    // An edit of an old comment isn't new; what capcomd wrote is dropped.
    expect(emitted.map((t) => `${t.thread} ${t.id}`)).toEqual(["acme/app#12 comment-2"]);
    expect(asked.map(([r]) => r)).toEqual(["acme/app", "acme/other"]);
    expect(((await store.get("daemon", "github/acme/app")) as { since: string }).since).toBe(latest);
  });
});

describe("ctx.storage and built-in config", () => {
  test("daemon-scope storage: get, put, cas, list, delete; keys are checked; run scope isn't available yet", async () => {
    const s = pluginStorage(join(home, "plugins", "p"));
    expect(await s.get("daemon", "a/b")).toBeUndefined();
    await s.put("daemon", "a/b", { n: 1 });
    expect(await s.get("daemon", "a/b")).toEqual({ n: 1 });
    expect(await s.cas("daemon", "a/b", { n: 2 }, { n: 3 })).toBe(false);
    expect(await s.cas("daemon", "a/b", { n: 1 }, { n: 3 })).toBe(true);
    expect(await s.cas("daemon", "new", undefined, 1)).toBe(true);
    expect(await s.list("daemon", "a/")).toEqual(["a/b"]);
    await s.delete("daemon", "a/b");
    expect(await s.list("daemon", "")).toEqual(["new"]);
    await expect(s.put("daemon", "../x", 1)).rejects.toBeInstanceOf(PluginError);
    await expect(s.get({ runId: "run-1" }, "x")).rejects.toMatchObject({ code: "unsupported" });
  });

  test("a built-in's config: plugins.<name> in the user's config, then CAPCOMD_PLUGIN_<NAME>_<KEY>; enabled: false turns it off", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { "source-schedule": { enabled: false, schedules: { a: { text: "x", everyMs: 1000 } } } } }));
    const c = { source: "builtin" as const, manifest: scheduleManifest, module: schedulePlugin as Candidate["module"] };
    expect(configured(c, { CAPCOMD_HOME: home })).toMatchObject({ enabled: false, config: { schedules: { a: { text: "x", everyMs: 1000 } } } });
    expect(configured(c, { CAPCOMD_HOME: home, CAPCOMD_PLUGIN_SOURCE_SCHEDULE_SCHEDULES: "{}" }).config).toEqual({ schedules: {} });
    expect(configured(c, { CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" })).toEqual(c);
  });
});
