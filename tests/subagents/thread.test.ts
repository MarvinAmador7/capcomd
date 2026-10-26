// harness.v1 agent threads against a real engine: a lead (a real CLI agent allowed to spawn, here the fake claude in
// a host-exec FakeProvider) gets thread items over GET /v1/runs/{runId}/agents/{agentId}/thread: its markdown as
// blocks, a tool call open → done with the CLI's duration, and a child's hand-back card. Before, agents that can spawn
// wrote nothing of their own. The legacy transcript and `capcomd logs` are unchanged.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { addClient, loadClients } from "../../src/api/clients";
import { ThreadPage } from "../../src/api/contract";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";

let engine: Engine;
let env: Record<string, string>;
let app: ReturnType<typeof harnessApp>;
let token = "";
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-thread-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 20, children: { allowSpawn: true, maxDepth: 1, maxChildren: 2, allowedChildProfiles: ["worker"] } },
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  } }));
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    ANTHROPIC_API_KEY: "sk-ant-api03-THREAD-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("thread", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
  const clients = join(dir, "clients.json");
  token = addClient("menubar", ["read"], clients).token;
  app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};
const get = async (p: string) => (await app.request(p, { headers: { authorization: `Bearer ${token}` } }));

test("a lead's thread: markdown as blocks, a timed tool call open → done, a child's hand-back; logs unchanged", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const lead = (await cj(["spawn", run, "--profile", "lead", "--task", "[thread] plan the backfill", "--key", "lead"])).j?.agentId;
  expect(lead).toMatch(/^agt-/);
  const sp = await cj(["spawn", run, "--profile", "worker", "--parent", lead, "--task", "make the failing test pass", "--key", "child"]);
  const child = sp.j?.agentId;
  if (!child) console.log(sp.stdout, sp.stderr);
  expect(child).toMatch(/^agt-/);
  const done = await cj(["await", run, lead, child, "--timeout-ms", "90000"]);
  expect(done.j?.agents?.map((a: any) => a.status).every((s: string) => ["done", "failed"].includes(s))).toBe(true);

  // Everything, paging by cursor as a client does.
  const items: any[] = [];
  for (let after = 0, i = 0; i < 20; i++) {
    const res = await get(`/v1/runs/${run}/agents/${lead}/thread?after=${after}&limit=3`);
    expect(res.status).toBe(200);
    const page = await res.json() as any;
    expect(ThreadPage.safeParse(page).success).toBe(true);
    items.push(...page.items);
    if (page.next === null) break;
    after = page.next;
  }
  const final = new Map<string, any>();
  for (const it of items) if (!final.has(it.id) || final.get(it.id).rev < it.rev) final.set(it.id, it);
  const thread = [...final.values()].sort((a, b) => a.order - b.order);
  expect(thread.every((i) => i.agentId === lead && i.format === "blocks/1")).toBe(true);

  const say = thread.find((i) => i.kind === "say");
  expect(say.blocks.map((b: any) => b.t)).toEqual(["heading", "list", "code", "table", "paragraph"]);
  expect(say.text).toContain("## Plan\n\n- Normalize emails");
  expect(say.blocks[4].children.find((x: any) => x.t === "link")).toMatchObject({ target: "file", path: "ids/v1/schema.json" });
  expect(thread.find((i) => i.kind === "thinking")).toMatchObject({ text: "Plan the backfill first.", redacted: false });
  const glob = thread.find((i) => i.tool?.name === "Glob");
  expect(glob).toMatchObject({ status: "done", durationMs: 412, tool: { summary: "Find **/*.ts", isError: false } });
  const globRevs = items.filter((i) => i.id === glob.id).map((i) => [i.rev, i.status]);
  expect(globRevs.at(-1)).toEqual([2, "done"]);
  expect(thread.find((i) => i.tool?.name === "Edit")).toMatchObject({ status: "done", tool: { summary: "Edit src/sum.ts", files: [{ target: "file", path: "src/sum.ts" }] } });
  // The child handed back into the lead's thread.
  expect(thread.find((i) => i.kind === "handoff")).toMatchObject({ child: { agentId: child, status: expect.stringMatching(/done|failed/) } });
  // Nothing agent-written leaks a credential.
  expect(JSON.stringify(items)).not.toContain("sk-ant-api03-THREAD");

  // The legacy transcript and `capcomd logs` keep their shape.
  const tr = await (await get(`/v1/runs/${run}/agents/${lead}/transcript`)).json() as any;
  expect(Object.keys(tr.items[0] ?? { seq: 0, at: "", stream: "", text: "" }).sort()).toEqual(["at", "seq", "stream", "text"]);
  const logs = (await cj(["logs", run, child])).j;
  expect(logs.lines.map((l: any) => l.line)).toEqual(expect.arrayContaining([expect.stringMatching(/^tool Edit/), expect.stringMatching(/^result/)]));
  expect(Object.keys(logs.lines[0]).sort()).toEqual(["at", "line", "seq", "stream"]);

  expect((await get(`/v1/runs/${run}/agents/agt-nope/thread`)).status).toBe(404);
}, 180_000);

test("full-size writes reach the scope: a 64 KB message and a 5 MB image, through the writer's calls", async () => {
  const { client } = await import("../../src/core/relay");
  const { itemWriter } = await import("../../src/agents/thread-store");
  const { threadBuilder, checkImage } = await import("../../packages/agent-thread/src/index");
  const run = (await cj(["run", "new"])).j?.runId;
  const a = (await cj(["spawn", run, "--profile", "worker", "--task", "x", "--key", "big", "--no-start"])).j?.agentId;
  const scope = client().scope.getOrCreate([run]);
  const write = itemWriter(scope as any, a);
  // A PNG of ~5 MB: a valid header, then filler the sniffer doesn't read.
  const png = Buffer.alloc(5 * 1024 * 1024 - 64);
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64").copy(png);
  const images: any[] = [];
  const b = threadBuilder({ cli: "claude", idPrefix: `itm-${a}-big`, onImage: (i) => images.push(i) });
  const md = Array.from({ length: 70 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(200)}`).join("\n\n");
  const drafts = [
    ...b.event({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: md }] } }),
    ...b.event({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "s", name: "mcp__b__shot", input: {} }] } }),
    ...b.event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s", content: [{ type: "image", source: { type: "base64", data: png.toString("base64") } }] }] } }),
  ];
  expect(images.length).toBe(1);
  expect("id" in checkImage(png.toString("base64"))).toBe(true);
  write(drafts, images.map((i) => ({ id: i.id, sha256: i.sha256, bytes: i.bytes, mime: i.mime, base64: i.base64 })));
  await write.flush();
  const page = await (await get(`/v1/runs/${run}/agents/${a}/thread`)).json() as any;
  const say = page.items.find((i: any) => i.kind === "say");
  expect(say.truncated?.blocks).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(say.blocks))).toBeLessThanOrEqual(64 * 1024);
  const tool = page.items.filter((i: any) => i.kind === "tool").at(-1);
  expect(tool.blocks[0]).toMatchObject({ t: "media", source: { type: "inline", attachmentId: images[0].id } });
  const bytes = await get(`/v1/runs/${run}/attachments/${images[0].id}/content`);
  expect(bytes.headers.get("content-type")).toBe("image/png");
  expect((await bytes.arrayBuffer()).byteLength).toBe(png.length);
}, 120_000);
