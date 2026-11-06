// ADR-024 §7 step 5 against a real engine and runner: a profile's `skills` reach the agent at its start through
// agent.preparing, the one mechanism the orchestration skill (the built-in skill-orchestration plugin) and plugins'
// skills (tests/plugins/fixtures/test-preparer) use too. What the agent gets (the fake claude in a host-exec sandbox):
// its profile's prompt, then the profile's skills, then the plugins' (the orchestration skill first), each once and in
// a block named for it; a lead whose profile names capcomd-orchestration gets it once. A skill is pinned when the agent
// is spawned: a SKILL.md edited after that changes the next agent's, never the spawned one's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { SKILL_TEXT } from "../plugins/fixtures/test-preparer/index";

let engine: Engine;
let env: Record<string, string>;
let dir = "";
const saved = { ...process.env };
const PLAN = "---\nname: plan\ndescription: How this team splits work\n---\n# Plan by file (profile skill)\nGive each child one file.";
const TDD = "---\nname: tdd\ndescription: Test first\n---\n# Test first (profile skill)\nWrite the failing test before the fix.";
const TDD_V2 = "---\nname: tdd\ndescription: Test first\n---\n# Test first, v2 (profile skill)\nRun the whole suite after the fix.";
const put = (rel: string, text: string) => { const p = join(dir, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  dir = mkdtempSync(join(tmpdir(), "capcomd-profile-skills-"));
  // The project's profiles are the profiles/ next to its agents file (src/profiles/load.ts profileLayers).
  const agentsFile = join(dir, "agents.json");
  put("profiles/lead/profile.yaml", [
    "name: lead", "harness: { provider: claude, auth: apikey }", "limits: { maxTurns: 20 }", "prompt: { append: Keep the team small. }",
    "children: { allowSpawn: true, maxChildren: 2, maxDepth: 1, allowedChildProfiles: [worker] }",
    "skills: [{ name: plan }, { name: capcomd-orchestration }]",
  ].join("\n"));
  put("profiles/lead/skills/plan/SKILL.md", PLAN);
  put("profiles/worker/profile.yaml", ["name: worker", "harness: { provider: claude, auth: apikey }", "limits: { maxTurns: 20 }", "skills: [{ name: tdd }]"].join("\n"));
  put("profiles/worker/skills/tdd/SKILL.md", TDD);
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
    CAPCOMD_RPC_KEY: `profile-skills-${Math.random()}`,
    ANTHROPIC_API_KEY: "sk-ant-api03-PROFSKILL-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_TEST_PLUGINS: new URL("../plugins/fixtures/test-preparer", import.meta.url).pathname,
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("profile-skills", { port, dataDir: join(dir, "engine") });
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
const spawn = async (run: string, profile: string, key: string, more: string[] = []) => {
  const r = await cj(["spawn", run, "--profile", profile, "--task", "Fix the sum helper", "--key", key, ...more]);
  if (!r.j?.agentId) console.log(r.stdout, r.stderr);
  expect(r.j?.agentId).toMatch(/^agt-/);
  return r.j.agentId as string;
};
async function finished(run: string, id: string) {
  const done = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  if (done?.status !== "done") console.log(JSON.stringify(done), (await cj(["logs", run, id])).stdout);
  expect(done?.status).toBe("done");
  return { system: readFileSync(join(workDir(id), "append-system.txt"), "utf8"), env: readFileSync(join(workDir(id), "plugin-env.txt"), "utf8") };
}
const times = (text: string, part: string) => text.split(part).length - 1;
const body = (md: string) => md.slice(md.indexOf("# "));

test("a lead gets its profile's prompt, its profile's skill, then the orchestration skill once, then a plugin's", async () => {
  const run = (await cj(["run", "new", "--key", `pfs-${Date.now()}`])).j.runId as string;
  const lead = await finished(run, await spawn(run, "lead", "lead"));
  const own = lead.system.indexOf("Keep the team small."), plan = lead.system.indexOf('<skill name="plan">');
  const orch = lead.system.indexOf('<skill name="capcomd-orchestration">'), cite = lead.system.indexOf('<skill name="cite-files">');
  expect(own).toBe(0);
  expect(plan).toBeGreaterThan(own);
  expect(orch).toBeGreaterThan(plan);
  expect(cite).toBeGreaterThan(orch);
  expect(lead.system).toContain(`<skill name="plan">\n${PLAN}\n</skill>`);
  // Once each, though the profile names capcomd-orchestration and the built-in plugin attaches it.
  expect(times(lead.system, body(PLAN))).toBe(1);
  expect(times(lead.system, '<skill name="capcomd-orchestration">')).toBe(1);
  expect(times(lead.system, "# Orchestrating child agents (capcomd)")).toBe(1);
  expect(times(lead.system, SKILL_TEXT)).toBe(1);
  // A plugin sees the profile's skills in the payload (so it can't attach one again), then the orchestration skill.
  expect(lead.env).toBe("PLUGIN_SAW_SKILLS=plan,capcomd-orchestration\nPLUGIN_TEAM=payments\n");

  const worker = await finished(run, await spawn(run, "worker", "worker"));
  expect(worker.system.indexOf(`<skill name="tdd">\n${TDD}\n</skill>`)).toBe(0);
  expect(times(worker.system, body(TDD))).toBe(1);
  expect(worker.system).not.toContain("Orchestrating child agents");
  expect(worker.system).toContain("# Name your tab (capcomd)");
  expect(worker.env).toBe("PLUGIN_SAW_SKILLS=tdd\nPLUGIN_TEAM=payments\n");
}, 180_000);

test("a skill is pinned when the agent is spawned: an edit after that is the next agent's", async () => {
  const run = (await cj(["run", "new", "--key", `pfs-pin-${Date.now()}`])).j.runId as string;
  // Spawned, not started: it is prepared after the edit, and still gets the text it was spawned with.
  const pinned = await spawn(run, "worker", "pinned", ["--no-start"]);
  put("profiles/worker/skills/tdd/SKILL.md", TDD_V2);
  const later = await spawn(run, "worker", "later");
  const a = await finished(run, pinned), b = await finished(run, later);
  expect(a.system).toContain(body(TDD));
  expect(a.system).not.toContain(body(TDD_V2));
  expect(b.system).toContain(body(TDD_V2));
  expect(b.system).not.toContain(body(TDD));
  // The pin is on the agent's spec by hash; the text is the run's (an attachment), not the event's.
  const ev = (await cj(["events", run, "--from-start", "--until", "agent.spawned", "--timeout-ms", "5000"])).stdout;
  expect(ev).not.toContain("Write the failing test before the fix.");
}, 180_000);
