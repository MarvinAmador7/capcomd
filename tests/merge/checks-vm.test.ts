// Checks in a VM: with real agents the tree under test is agent-written code, so verify runs the check
// command in a throwaway VM (here: FakeProvider in hostExec mode, so "VM" paths are host temp dirs).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FakeProvider } from "../../src/providers/fake";
import { initDependencies, resetDependencies } from "../../src/dependencies";
import { Git } from "../../src/merge/git";
import { checksMode, runTests } from "../../src/merge/verify";

const saved = { ...process.env };
let git: Git;
let provider: FakeProvider;
const log: Array<{ cmd: string[]; envKeys: string[] }> = [];

beforeAll(async () => {
  const repo = mkdtempSync(join(tmpdir(), "capcomd-checks-repo-"));
  git = new Git(repo);
  await git.ok(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "ok.sh"), "echo checked-ok\n");
  writeFileSync(join(repo, "README.md"), "# t\n");
  await git.ok(["add", "."]);
  await git.ok(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"]);
  provider = new FakeProvider({ hostExec: true, log });
  initDependencies({ provider });
  Object.assign(process.env, { CAPCOMD_CHECKS: "vm", CAPCOMD_AGENT_WORKDIR: mkdtempSync(join(tmpdir(), "capcomd-checks-vm-")), CAPCOMD_ENV: "image", CAPCOMD_CHECKS_HOST_SECRET: "sk-ant-api03-must-not-leak-0123456789" });
});
afterAll(() => { resetDependencies(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

describe("checks in a VM", () => {
  test("mode: boxd → vm, fakes → host, CAPCOMD_CHECKS overrides", () => {
    expect(checksMode({ CAPCOMD_SANDBOX: "boxd" })).toBe("vm");
    expect(checksMode({ CAPCOMD_SANDBOX: "fake" })).toBe("host");
    expect(checksMode({})).toBe("host");
    expect(checksMode({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_CHECKS: "host" })).toBe("host");
    expect(checksMode({ CAPCOMD_CHECKS: "vm" })).toBe("vm");
  });

  test("runs the command on the archived tree (no .git), only the ids in its env, and destroys the VM", async () => {
    const ids = { CAPCOMD_RUN_ID: "run-x", CAPCOMD_TASK_ID: "agt-x", CAPCOMD_TARGET: "main" };
    const ok = await runTests(git, 'sh ok.sh && [ ! -d .git ] && [ "$CAPCOMD_TASK_ID" = agt-x ] && [ -z "$CAPCOMD_CHECKS_HOST_SECRET" ] && echo isolated', ids);
    expect(ok).toMatchObject({ passed: true, where: "vm" });
    expect(ok.output).toContain("checked-ok");
    expect(ok.output).toContain("isolated");
    const bad = await runTests(git, "echo nope >&2; exit 3", ids);
    expect(bad).toMatchObject({ passed: false, where: "vm" });
    expect(bad.output).toContain("nope");
    // Every checks VM was created isolated with registry-only egress, and destroyed.
    const checksVms = [...(provider as any).vms.values()].filter((v: any) => /^capcomd-checks-run-x-agt-x-/.test(v.spec.idemKey));
    expect(checksVms.length).toBe(2);
    for (const v of checksVms) {
      expect(v.spec).toMatchObject({ isolated: true, egressAllow: ["github.com", "registry.npmjs.org", "nodejs.org"] });
      expect(v.state).toBe("destroyed");
    }
    expect((await provider.list("")).length).toBe(0); // nothing left running
    expect(log.every((l) => !l.envKeys.includes("CAPCOMD_CHECKS_HOST_SECRET"))).toBe(true);
  });

  test("host mode keeps the old behavior (the worktree itself, on the host)", async () => {
    process.env.CAPCOMD_CHECKS = "host";
    try {
      const r = await runTests(git, "[ -d .git ] && echo on-host", {});
      expect(r).toMatchObject({ passed: true, where: "host" });
    } finally { process.env.CAPCOMD_CHECKS = "vm"; }
  });
});
