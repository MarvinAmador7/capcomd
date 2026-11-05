// Team shapes: what a driver needs to plan one. The lead profile setup writes, what each profile can do in plain words,
// a `children` grant that has no effect, how many agents run at once here, and the skill's "Choose a team shape".
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { planProject, testTools } from "../../src/config/project-setup";
import { abilityText, leadText, validateFile, widenings, type AgentsFile } from "../../src/agents/profiles";
import { applyGrant, childLimits, rootLimits } from "../../src/primitives/policy";
import { placeCapacity, teamShapeHint } from "../../src/providers/capacity";
import { INSTRUCTIONS } from "../../src/mcp/server";
import { ORCHESTRATION_SKILL } from "../../src/utils/assets";

const GB = 1024 ** 3;
const answers = (dir: string, check = "bun run test") => ({ dir, repo: "https://github.com/a/b.git", mode: "direct", target: "main", check, agents: ["claude"], authOf: () => "subscription", cap: null });

describe("the profiles setup writes", () => {
  test("a lead: the worker's settings, orchestrating up to 3 worker helpers, one level; a valid agents file", () => {
    const plan = planProject(answers(mkdtempSync(join(tmpdir(), "capcomd-ts-"))));
    const by = Object.fromEntries(plan.profiles);
    expect(plan.profiles.map(([n]) => n)).toEqual(["worker", "reviewer", "lead", "planner"]);
    // Plugin API §16.1: the lead and the planner orchestrate; their workers do the work.
    expect(by.lead).toEqual({ ...by.worker, toolMode: "orchestrate", children: { allowSpawn: true, maxChildren: 3, maxDepth: 1, allowedChildProfiles: ["worker"] } });
    expect(by.planner!.toolMode).toBe("orchestrate");
    expect(by.worker!.toolMode).toBeUndefined();
    const file: AgentsFile = { schema: "capcomd.agents/v1", default: "worker", agents: by as any };
    expect(validateFile(file)).toEqual([]);
    expect(leadText(by.lead as any)).toBe("up to 3 worker helpers, one level");
  });

  test("the reviewer may run the check's commands and the package manager's test runner", () => {
    const bun = mkdtempSync(join(tmpdir(), "capcomd-ts-"));
    writeFileSync(join(bun, "bun.lock"), "");
    expect(testTools("bun run test", bun)).toEqual(["Bash(bun run:*)", "Bash(bun test:*)"]);
    expect(testTools("CI=1 bun run typecheck && bun test", bun)).toEqual(["Bash(bun run:*)", "Bash(bun test:*)"]);
    const pnpm = mkdtempSync(join(tmpdir(), "capcomd-ts-"));
    writeFileSync(join(pnpm, "pnpm-lock.yaml"), "");
    expect(testTools("pnpm run check", pnpm)).toEqual(["Bash(pnpm run:*)", "Bash(pnpm test:*)"]);
    const npm = mkdtempSync(join(tmpdir(), "capcomd-ts-"));
    writeFileSync(join(npm, "package.json"), "{}");
    expect(testTools("npm test", npm)).toEqual(["Bash(npm test:*)", "Bash(npm run:*)"]);
    // A new repository: no lockfile yet, the check's own package manager.
    const empty = mkdtempSync(join(tmpdir(), "capcomd-ts-"));
    expect(testTools("bun test", empty)).toEqual(["Bash(bun test:*)", "Bash(bun run:*)"]);
    expect(testTools("", empty)).toEqual([]);
    writeFileSync(join(empty, "Cargo.toml"), "");
    expect(testTools("make check", empty)).toEqual(["Bash(make check:*)", "Bash(cargo test:*)"]);
    const rev = Object.fromEntries(planProject(answers(bun)).profiles).reviewer as any;
    expect(rev.allowedTools).toEqual(expect.arrayContaining(["Read", "Bash(git diff:*)", "Bash(bun run:*)", "Bash(bun test:*)"]));
    expect(rev.allowedTools.some((t: string) => /^(Edit|Write)/.test(t))).toBe(false);
  });

  test("what each profile can do, in plain words", () => {
    expect(leadText({})).toBeNull();
    expect(leadText({ children: { allowSpawn: true, allowedChildProfiles: ["worker", "codex-worker"] } })).toBe("any number of worker or codex-worker helpers, any depth");
    expect(leadText({ children: { allowSpawn: true, maxChildren: 1, maxDepth: 2, allowedChildProfiles: ["coder"] } })).toBe("up to 1 coder helper, 2 levels");
    expect(abilityText({ children: { allowSpawn: true, maxChildren: 3, maxDepth: 1, allowedChildProfiles: ["worker"] } })).toContain("leads a part: spawns up to 3 worker helpers, one level");
    expect(abilityText({})).toContain("can't spawn helpers (fan-out for it is refused)");
    expect(abilityText({ allowedTools: ["Read", "Bash(bun test:*)"] })).toContain("read-only");
  });
});

describe("a children grant that would have no effect", () => {
  test("fan-out for an agent that can't spawn is refused with what to do; a leaf grant is fine", () => {
    const worker = rootLimits(undefined);
    for (const g of [{ maxChildren: 3 }, { maxDepth: 1 }, { allowSpawn: true }, { allowedChildProfiles: ["worker"] }]) {
      const r = applyGrant(worker, g);
      expect(r.ok).toBe(false);
      expect((r as any).error).toContain("this agent can't spawn");
      expect((r as any).error).toContain("spawn a profile that can lead (capcomd_profiles canLead, e.g. lead)");
    }
    expect(applyGrant(worker, { maxChildren: 0 })).toMatchObject({ ok: true, limits: { allowSpawn: false } });
    const lead = rootLimits({ allowSpawn: true, maxChildren: 3, maxDepth: 1, allowedChildProfiles: ["worker"] });
    expect(applyGrant(lead, { maxChildren: 2, maxDepth: 1 })).toMatchObject({ ok: true, limits: { allowSpawn: true, maxChildren: 2 } });
  });

  test("a planner may spawn a lead, and the lead keeps its own helpers one level down", () => {
    const by = Object.fromEntries(planProject(answers(mkdtempSync(join(tmpdir(), "capcomd-ts-")))).profiles) as Record<string, any>;
    expect(by.planner.children.allowedChildProfiles).toEqual(["worker", "lead"]);
    expect(widenings(by.planner, by.lead)).toEqual([]);
    const underPlanner = childLimits(rootLimits(by.planner.children), by.lead.children);
    expect(applyGrant(underPlanner, { maxChildren: 3, maxDepth: 1 })).toMatchObject({ ok: true, limits: { allowSpawn: true, maxChildren: 3, maxDepth: 1, allowedChildProfiles: ["worker"] } });
  });
});

describe("how many agents run at once here", () => {
  test("Docker: its memory over the memory per agent; boxd: no local cap; fakes: none unless given memory", async () => {
    const d = await placeCapacity("docker", {}, async () => 7.8 * GB);
    expect(d).toMatchObject({ sandbox: "docker", agentsAtOnce: 7 });
    expect(d.detail).toContain("7.8 GB");
    expect(teamShapeHint(d)).toBe("Plan the team shape first (skill: Choose a team shape): 7 agents can run at once here (docker).");
    expect((await placeCapacity("docker", { CAPCOMD_DOCKER_AGENT_MEMORY_MB: "2048" }, async () => 8 * GB)).agentsAtOnce).toBe(4);
    expect(await placeCapacity("docker", {}, async () => null)).toMatchObject({ agentsAtOnce: null, detail: expect.stringContaining("isn't known") });
    const b = await placeCapacity("boxd", {});
    expect([b.sandbox, b.agentsAtOnce]).toEqual(["boxd", null]);
    expect(b.detail).toContain("no local cap");
    expect(teamShapeHint(b)).toContain("there's no fixed number of agents at once here (boxd: no local cap");
    expect((await placeCapacity("fake", {})).agentsAtOnce).toBeNull();
    expect((await placeCapacity("fake-host", { CAPCOMD_FAKE_MEMORY_MB: "3072" })).agentsAtOnce).toBe(3);
  });
});

describe("the steering a driver reads", () => {
  test("the skill opens with Choose a team shape, before the primitives", () => {
    const s = ORCHESTRATION_SKILL;
    const at = (h: string) => { const i = s.indexOf(h); expect(i).toBeGreaterThan(0); return i; };
    expect(at("## Choose a team shape")).toBeLessThan(at("## Primitives (reference)"));
    for (const h of ["**1. Single loop.**", "**2. Wide fan-out.**", "**3. Contract first, then wide.**", "**4. Leads with helpers.**", "### What the user says → the shape", "### Plan check"]) at(h);
    expect(s).toContain("simplest shape that gives what the user\nasked for");
    expect(s).not.toContain("Default every child to a leaf");
    expect(s).toContain("children: {maxChildren: N, maxDepth: 1}");
    // A marked spot for the waiting and polling lines other changes add.
    expect(at("<!-- capcomd: waiting and polling guidance")).toBeLessThan(at("<!-- end: waiting and polling guidance -->"));
    expect(s).toContain("verify's checks run in Linux containers or VMs");
    // The file the plugins ship is the one capcomd bundles (Hermes, Claude Code without the plugin).
    expect(readFileSync(new URL("../../plugins/capcomd/skills/capcomd-orchestration/SKILL.md", import.meta.url), "utf8")).toBe(s);
  });

  test("the MCP server's instructions: what capcomd is, the shapes, the skill, capcomd_setup first", () => {
    for (const t of ["capcomd runs a team of coding agents", "single loop", "wide fan-out", "contract first, then wide", "leads with helpers", "capcomd-orchestration skill", "Start with capcomd_setup"]) expect(INSTRUCTIONS).toContain(t);
    expect(INSTRUCTIONS.length).toBeLessThan(1500);
  });
});
