// Plugin API §15.4, §17.2 step 13: the Slack example (packages/plugin/examples/slack-notifier), unchanged, as a user's
// plugin of a real daemon on the fake sandbox, booted by the test kit's own `bootWith` (§14.3) as a plugin author's
// tests boot it. Slack is a local HTTP server standing in for the incoming webhook. The example starts out of process,
// gets its secret in the handshake, posts what §16.5 says it speaks about (a run that started and ended, an agent that
// failed) and nothing for an agent that finished, and writes `plugin.slack-notifier.posted` on the run's stream.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { testkit, type BootedDaemon } from "../../packages/plugin/src/testkit";

const ROOT = join(import.meta.dir, "..", "..");
const EXAMPLE = join(ROOT, "packages", "plugin", "examples", "slack-notifier");
const posts: Array<{ path: string; body: { channel: string; text: string } }> = [];
let slack: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  slack = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      posts.push({ path: new URL(req.url).pathname, body: (await req.json()) as { channel: string; text: string } });
      return new Response("ok");
    },
  });
});
afterAll(() => slack.stop(true));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, f: () => T | undefined | Promise<T | undefined>, ms = 60_000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await f(); if (v) return v; }
  throw new Error(`timed out waiting for ${what}; Slack got ${JSON.stringify(posts.map((p) => p.body.text))}`);
};
const said = (text: string) => posts.find((p) => p.body.text === text);

test("the Slack example runs against a daemon on the fake sandbox: it posts what it speaks about, and only that", async () => {
  await testkit.bootWith([{ dir: EXAMPLE }], async (d: BootedDaemon) => {
    // Active: it opened its session (manifest hash and hooks checked) and its hooks stream.
    expect((await (await d.fetch("/v1/plugins/slack-notifier")).json()) as object).toMatchObject({ runtime: "process", source: "user", state: "active", hooks: ["run.changed", "agent.changed", "merge.changed"] });
    const run = (await d.cli(["run", "new", "--budget", "usd=1,turns=50", "--key", "slack-example", "--json"])).json?.runId as string;
    expect(run).toMatch(/^run-/);
    // A run starts with its first agent. An agent that finishes is not news; one that fails is.
    const spawn = async (key: string, script: string) => {
      const r = await d.cli(["spawn", run, "--profile", "worker", "--task", `write the ${key}`, "--key", key, "--contract", JSON.stringify({ script }), "--json"]);
      if (!r.json?.agentId) throw new Error(`spawn ${key}: ${r.stdout} ${r.stderr}`);
      return r.json.agentId as string;
    };
    const ok = await spawn("parser", "true"), bad = await spawn("tests", "exit 1"), slow = await spawn("docs", "sleep 120");
    const awaited = (await d.cli(["await", run, ok, bad, "--timeout-ms", "60000", "--json"])).json;
    expect(awaited.agents.map((a: { status: string }) => a.status).sort()).toEqual(["done", "failed"]);
    await until("the run's start on Slack", () => said(`Run ${run} started.`));
    expect(posts[0]).toEqual({ path: "/hooks/T000/B000", body: { channel: "#ci", text: `Run ${run} started.` } });
    await until("the failed agent on Slack", () => said(`Agent ${bad} (worker) failed in run ${run}.`));

    // A person stops the run: its end is posted; the agent it cancelled, like the one that finished, is not.
    expect((await d.fetch(`/v1/runs/${run}/cancel`, { method: "POST", idempotencyKey: "slack-example-cancel" })).status).toBe(200);
    await until("the run's end on Slack", () => posts.find((p) => p.body.text.startsWith(`Run ${run} cancelled`)));
    expect(posts.some((p) => p.body.text.includes(ok) || p.body.text.includes(slow))).toBe(false);

    // Each post is recorded on the run's stream as the plugin's own event.
    const events = await until("the posted events", async () => {
      const evs = (await (await d.fetch(`/v1/events?scope=${run}`)).json()) as Array<{ type: string; data: { hook: string; channel: string } }>;
      const mine = evs.filter((e) => e.type === "plugin.slack-notifier.posted");
      return mine.length >= posts.length ? mine : undefined;
    });
    expect(events.map((e) => e.data.hook).sort()).toEqual(["agent.changed", "run.changed", "run.changed"]);
    // The webhook URL is a secret: it reached the process in its handshake, never the daemon's log.
    expect(d.log()).not.toContain("/hooks/T000/B000");
  }, {
    capcomd: ["bun", join(ROOT, "src", "cli", "index.ts")],
    config: { "slack-notifier": { webhook: { $secret: "env:SLACK_WEBHOOK_URL" }, channel: "#ci" } },
    env: {
      SLACK_WEBHOOK_URL: `http://127.0.0.1:${slack.port}/hooks/T000/B000`,
      // The test isolation guard (tests/helpers/isolate-config.ts) in the daemon too: bootWith passes none of capcomd's.
      CAPCOMD_TEST_GUARD_LOG: process.env.CAPCOMD_TEST_GUARD_LOG ?? "", CAPCOMD_TEST_REAL_HOME: process.env.CAPCOMD_TEST_REAL_HOME ?? "",
    },
  });
}, 240_000);

test("bootWith says why a plugin isn't running, and leaves nothing behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-bootwith-"));
  const manifest = { schema: "capcomd.plugin/v1", name: "too-old", version: "1.0.0", description: "Made for an older capcomd.", apiVersion: 1, engines: { capcomd: "<0.1.0" }, entry: { runtime: "process", command: ["node", "-e", "setInterval(() => {}, 1000)"] }, contributes: { hooks: { "run.changed": {} } } };
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  const homes = () => readdirSync(tmpdir()).filter((n) => n.startsWith("cpk-")).sort();
  const before = homes();
  let ran = false;
  const opts = { capcomd: ["bun", join(ROOT, "src", "cli", "index.ts")], env: { CAPCOMD_TEST_GUARD_LOG: process.env.CAPCOMD_TEST_GUARD_LOG ?? "", CAPCOMD_TEST_REAL_HOME: process.env.CAPCOMD_TEST_REAL_HOME ?? "" } };
  // The daemon refuses it (§4.4): the boot fails with the plugin's state and cause, before the test's code runs.
  await expect(testkit.bootWith([{ dir }], async () => { ran = true; }, opts)).rejects.toThrow(/the too-old plugin is failed \(incompatible\)/);
  // A manifest that doesn't validate fails before any daemon starts.
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ ...manifest, scopes: ["approve"] }));
  await expect(testkit.bootWith([{ dir }], async () => { ran = true; }, opts)).rejects.toThrow(/scopes/);
  expect(ran).toBe(false);
  expect(homes()).toEqual(before);
  rmSync(dir, { recursive: true, force: true });
}, 180_000);
