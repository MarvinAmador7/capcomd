// recipe-hierarchical (plugin API §17.1, ADR-023 decision 5): `capcomd run` without a planner agent goes through this
// built-in, which is off until a person turns it on. Its runs end to end: tests/cli/json.test.ts (on, and refused while
// off), tests/scenarios/local-slots.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { BUILTINS, candidateOf, OPT_IN } from "../../src/plugins/builtins";
import { kernelHost } from "../../src/plugins/host";
import { CARD, hierarchicalRecipe, landUnlessMemory, manifest, MEMORY_REFUSED, memoryRefusal } from "../../src/plugins/recipe-hierarchical";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { mergeTask } from "../../src/merge/service";
import { taskBranch, taskKey } from "../../src/merge/config";
import { bareRepo, withoutEngine } from "../merge/gitfixture";

const builtin = BUILTINS.find((b) => (b.manifest as { name: string }).name === "recipe-hierarchical")!;
let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

describe("recipe-hierarchical", () => {
  test("a built-in loaded wherever capcomd run runs, off by default, and one a person may turn off again", () => {
    expect(builtin).toMatchObject({ everyProcess: true, off: true });
    expect(OPT_IN.has("recipe-hierarchical")).toBe(true);
    expect(candidateOf(builtin).enabled).toBe(false);
  });

  test("while active it registers the recipe and its card; turned off, the recipe is gone", async () => {
    const host = kernelHost({ log: false });
    stop = () => host.stop();
    await host.start([{ ...candidateOf(builtin), enabled: true }]);
    expect(host.list().find((p) => p.name === manifest.name)).toMatchObject({ state: "active" });
    const card = host.contributions.list("ui").find((e) => e.plugin === manifest.name)!.value.descriptor;
    expect(card).toMatchObject({ kind: "card", id: "recipe", title: CARD.title });
    expect(await (card as { read(): Promise<unknown> }).read()).toEqual({ lines: [...CARD.lines], state: "warn" });
    const r = await hierarchicalRecipe();
    expect(typeof r.recipe).toBe("function");
    expect(typeof r.legacy).toBe("function");
    await host.disable(manifest.name);
    expect(host.contributions.list("ui").filter((e) => e.plugin === manifest.name)).toEqual([]);
    // This process's own host (the CLI's) has it off, as every process does by default: refused, naming it.
    const refused = await hierarchicalRecipe().then(() => null, (e) => e);
    expect(refused).toMatchObject({ code: "config", reason: "plugin:recipe-hierarchical" });
    expect(refused.message).toContain("recipe-hierarchical isn't running: validated (disabled)");
  });
});

// ADR-025 §5.3: these runs have no memory gate (`--legacy` asks no merge.landing plugin), so a worker branch that changes
// .capcomd/context/ is refused before its merge; one that doesn't lands as before. Against a local bare repo.
describe("recipe-hierarchical never lands memory", () => {
  withoutEngine();
  const req = (runId: string, taskId: string) => ({ runId, taskId, branch: taskBranch(runId, taskId), target: "main" });
  /** A worker's branch off main with `files` committed, pushed. */
  async function workerBranch(r: Awaited<ReturnType<typeof bareRepo>>, branch: string, files: Record<string, string>) {
    await r.seed.ok(["checkout", "-q", "-B", branch, "main"]);
    for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(r.root, "seed", p)), { recursive: true }); writeFileSync(join(r.root, "seed", p), body); }
    await r.seed.ok(["add", "."]);
    await r.seed.ok(["commit", "-q", "-m", `work on ${branch}`]);
    await r.seed.ok(["push", "-q", "origin", `${branch}:${branch}`]);
    await r.seed.ok(["checkout", "-q", "main"]);
  }

  test("--legacy: a branch adding .capcomd/context/lessons/x.md is refused and nothing lands; one without it lands", async () => {
    const r = await bareRepo();
    const memory = req("run-mem", "task-1");
    await workerBranch(r, memory.branch, { "src/a.txt": "a\n", ".capcomd/context/lessons/x.md": "---\nid: x\n---\nA lesson\n" });
    const before = await r.sha("main");
    let landed = 0;
    const out = await landUnlessMemory(r.cfg, memory, async () => { landed++; return mergeTask(memory, r.cfg); });
    expect(out.status).toBe("failed");
    expect(out.status === "failed" && out.reason).toContain(".capcomd/context/lessons/x.md");
    expect(out.status === "failed" && out.reason).toContain(MEMORY_REFUSED);
    expect(MEMORY_REFUSED).toContain("context-consolidator");
    expect(landed).toBe(0);
    expect(await r.sha("main")).toBe(before);
    expect(await r.landings(taskKey("run-mem", "task-1"))).toBe(0);

    const plain = req("run-mem", "task-2");
    await workerBranch(r, plain.branch, { "src/b.txt": "b\n" });
    const ok = await landUnlessMemory(r.cfg, plain, () => mergeTask(plain, r.cfg));
    expect(ok.status).toBe("merged");
    expect(await r.show("main", "src/b.txt")).toBe("b");
    expect(await r.landings(taskKey("run-mem", "task-2"))).toBe(1);
  });

  test("--recipe's check reads the verified commit, renames out of the directory and any spelling a checkout lands there", async () => {
    const r = await bareRepo();
    await workerBranch(r, "capcomd/run-r/agt-1", { "notes/y.md": "y\n" });
    expect(await memoryRefusal(r.cfg, { branch: "capcomd/run-r/agt-1", target: "main" })).toBeNull();
    await workerBranch(r, "capcomd/run-r/agt-2", { ".Capcomd/Context/lessons/y.md": "y\n" });
    const commit = await r.sha("capcomd/run-r/agt-2");
    expect(await memoryRefusal(r.cfg, { branch: "capcomd/run-r/agt-2", commit, target: "main" })).toContain(MEMORY_REFUSED);
    // The verified commit is what it judges, though the branch moved on to drop the file afterwards.
    await r.seed.ok(["fetch", "-q", "origin"]);
    await r.seed.ok(["checkout", "-q", "-B", "capcomd/run-r/agt-2", "origin/main"]);
    await r.seed.ok(["push", "-q", "-f", "origin", "capcomd/run-r/agt-2"]);
    await r.seed.ok(["checkout", "-q", "main"]);
    expect(await memoryRefusal(r.cfg, { branch: "capcomd/run-r/agt-2", commit, target: "main" })).toContain(".Capcomd/Context/lessons/y.md");
  });

  test("fail-closed: a branch it can't read doesn't land; with no repository nothing lands anywhere, so nothing is refused", async () => {
    const r = await bareRepo();
    expect(await memoryRefusal(r.cfg, { branch: "capcomd/run-x/agt-gone", target: "main" })).toContain("can't tell whether capcomd/run-x/agt-gone changes .capcomd/context/");
    expect(await memoryRefusal(r.cfg, { branch: "--upload-pack=x", target: "main" })).toContain("not a branch name");
    expect(await memoryRefusal(null, { branch: "capcomd/run-x/agt-1", target: "main" })).toBeNull();
    expect(await landUnlessMemory(null, { branch: "task/t", target: "main" }, async () => ({ status: "merged", sha: "", already: false, how: "none", strategy: "none", mode: "none", attempts: 0 }))).toMatchObject({ status: "merged" });
  });
});
