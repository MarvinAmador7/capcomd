// A project with no memory yet pays nothing for its context block (ADR-025 D17, the owner's decision of 2026-11-08),
// against a real engine and runner: a repository without .capcomd/context/, a worker and a lead whose profiles name the
// memory provider, and the fake claude in a host-exec sandbox (it writes the appended system prompt it was given). The
// worker starts with the prompt it would have without the context block, byte for byte: no brief, no doctrine, no
// routing paragraph; the lead keeps its orchestration skill and gets no context skill; the run says the memory was
// empty; `capcomd context brief` says so. Once the project's first memory item lands on the branch, the next agent
// gets the brief and both skills.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let env: Record<string, string>;
let dir = "";
let seed: Awaited<ReturnType<typeof bareRepo>>["seed"];
let seedDir = "";
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  seed = r.seed;
  seedDir = join(r.root, "seed");
  // An empty folder isn't in git; a .gitkeep in it is a file, but not memory.
  mkdirSync(join(seedDir, ".capcomd", "context"), { recursive: true });
  writeFileSync(join(seedDir, ".capcomd", "context", ".gitkeep"), "");
  await r.seed.ok(["add", "."]);
  await r.seed.ok(["commit", "-q", "-m", "a place for the project's memory"]);
  await r.seed.ok(["push", "-q", "origin", "main"]);
  dir = mkdtempSync(join(tmpdir(), "capcomd-context-empty-"));
  const agentsFile = join(dir, "agents.json");
  const memory = { providers: [{ name: "memory" }] };
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    worker: { provider: "claude", auth: "apikey", maxTurns: 20, appendSystemPrompt: "Work carefully.", context: memory },
    plain: { provider: "claude", auth: "apikey", maxTurns: 20, appendSystemPrompt: "Work carefully." },
    lead: { provider: "claude", auth: "apikey", maxTurns: 20, context: memory, children: { allowSpawn: true, maxChildren: 1, maxDepth: 1, allowedChildProfiles: ["worker"] } },
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
    CAPCOMD_RPC_KEY: `context-empty-${Math.random()}`,
    ANTHROPIC_API_KEY: "sk-ant-api03-CONTEXTEMPTY-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("context-empty", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
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
const workDir = (id: string) => join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes(id))!);
async function finished(run: string, profile: string, key: string) {
  const id = (await cj(["spawn", run, "--profile", profile, "--task", "Fix the sum helper", "--key", key])).j?.agentId as string;
  expect(id).toMatch(/^agt-/);
  const done = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  if (done?.status !== "done") console.log(JSON.stringify(done), (await cj(["logs", run, id])).stdout);
  expect(done?.status).toBe("done");
  return { id, system: readFileSync(join(workDir(id), "append-system.txt"), "utf8") };
}

test("no memory yet: no brief and no context skill (the prompt as without a context block); the first memory item turns both on", async () => {
  const { DOCTRINE_SKILL, ROUTING_SKILL } = await import("../../src/context/skills");
  const run = (await cj(["run", "new", "--key", `ce-${Date.now()}`])).j.runId as string;
  const w = await finished(run, "worker", "w");
  // Byte for byte what the same profile without a context block gets (its agent id aside), and proposing a lesson
  // stays open: its own capcomd lines say how.
  const p = await finished(run, "plain", "p");
  expect(w.system.replaceAll(w.id, "<agent>")).toBe(p.system.replaceAll(p.id, "<agent>"));
  expect(w.system).toStartWith("Work carefully.\n\n");
  expect(w.system).toContain(`--data '{"context": [{"title": "…", "text": "…"}]}'`);
  expect(w.system).not.toContain("Context: loaded");
  for (const s of [DOCTRINE_SKILL, ROUTING_SKILL]) expect(w.system).not.toContain(`<skill name="${s.name}">`);

  // As the kernel prepares an attempt: the agent's record as it is, and the same record with no context block,
  // prepare to the same prompt and skills.
  await (await import("../../src/plugins/hooks")).gates();
  const ops = await import("../../src/primitives/ops");
  const record = await ops.getAgentOrThrow(run, w.id);
  expect((record.spec as { context?: unknown }).context).toEqual({ providers: [{ name: "memory" }] });
  const { context: _c, ...bare } = record.spec as Record<string, unknown>;
  const prompt = (p: Awaited<ReturnType<typeof ops.agentPreparing>>) => ({ append: p?.appendSystemPrompt ?? null, skills: p?.skills ?? [] });
  const withBlock = prompt(await ops.agentPreparing(run, record, 2));
  expect(withBlock).toEqual(prompt(await ops.agentPreparing(run, { ...record, spec: bare } as typeof record, 2)));
  expect(withBlock.append ?? "").not.toContain("Context:");

  // One that may spawn keeps its orchestration skill, and gets no context skill either.
  const l = await finished(run, "lead", "l");
  expect(l.system).toContain(`<skill name="capcomd-orchestration">`);
  expect(l.system).not.toContain("Context: loaded");
  for (const s of [DOCTRINE_SKILL, ROUTING_SKILL]) expect(l.system).not.toContain(`<skill name="${s.name}">`);

  // The run says why: the memory provider had nothing; nothing was loaded.
  // (The worker's twice: its start and the attempt prepared above; the agent without the block never.)
  const evs = (await cj(["events", run, "--limit", "500"])).j?.events as Array<{ type: string; event?: any }>;
  const skipped = evs.filter((e) => e.type === "plugin.context.skipped").map((e) => [e.event?.agentId, e.event?.provider, e.event?.reason]);
  expect(skipped).toEqual([[w.id, "memory", "empty"], [w.id, "memory", "empty"], [l.id, "memory", "empty"]]);
  expect(evs.some((e) => e.type === "plugin.context.loaded")).toBe(false);
  const printed = await cj(["context", "brief", "worker"]);
  expect(printed.j).toMatchObject({ ok: true, brief: null, empty: true, skills: [] });
  expect(printed.j?.text).toContain("start with no brief and no context skills");

  // The project's first memory item lands on its branch: the next agent gets the brief and both skills.
  const ctx = join(seedDir, ".capcomd", "context", "memory");
  mkdirSync(ctx, { recursive: true });
  writeFileSync(join(ctx, "money-rounding.md"), "---\nid: money-rounding\ntype: lesson\nstatus: stable\ndescription: Money is rounded half-even (src/money.js)\nmodified: 2026-11-08\n---\n\nMath.round on money caused one-cent errors.\n");
  await seed.ok(["add", "."]);
  await seed.ok(["commit", "-q", "-m", "the first lesson"]);
  await seed.ok(["push", "-q", "origin", "main"]);
  const w2 = await finished(run, "worker", "w2");
  expect(w2.system).toStartWith("Work carefully.\n\nContext: loaded 1 of 1 lines");
  expect(w2.system).toContain("- [lesson] Money is rounded half-even (src/money.js) → .capcomd/context/memory/money-rounding.md");
  for (const s of [DOCTRINE_SKILL, ROUTING_SKILL]) expect(w2.system).toContain(`<skill name="${s.name}">`);
  expect((await cj(["context", "brief", "worker"])).j?.brief).toStartWith("Context: loaded 1 of 1 lines");
}, 240_000);
