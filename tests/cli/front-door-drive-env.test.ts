// Plugin API §6.1: a front door's verify, merge and approve sent to the daemon carry the front door's drive settings,
// with the agents file its project's profiles resolve from, as an agent's spawn records them (`driveEnv`). The daemon
// runs the operation with them (src/api/front-door.ts), so the run's reviewer is the profile the project where the
// command was typed defines, as when the front door ran the verify itself, not the daemon's profile of that name.
import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sent: Array<{ path: string; body: Record<string, any> }> = [];
mock.module("../../src/cli/daemon", () => ({
  engineDaemon: async () => ({ pid: process.pid, at: new Date().toISOString(), plugins: [], endpoint: "http://127.0.0.1:1", socket: "/nowhere.sock" }),
  daemonOp: async (_d: unknown, path: string, body: Record<string, any>) => {
    sent.push({ path, body });
    return { kind: "done", id: path.includes("/verifications") ? "vfy-1" : "mrg-1", value: { state: "passed" } };
  },
}));
const F = await import("../../src/primitives/front-door");

const project = mkdtempSync(join(tmpdir(), "front-door-proj-"));
mkdirSync(join(project, ".capcomd", "profiles"), { recursive: true });
const was = { cwd: process.cwd(), agentsFile: process.env.CAPCOMD_AGENTS_FILE };
afterAll(() => {
  process.chdir(was.cwd);
  if (was.agentsFile !== undefined) process.env.CAPCOMD_AGENTS_FILE = was.agentsFile;
  rmSync(project, { recursive: true, force: true });
});

test("verify, merge and approve sent to the daemon carry the project's agents file and this shell's drive settings", async () => {
  process.chdir(project);
  delete process.env.CAPCOMD_AGENTS_FILE;
  process.env.CAPCOMD_SPAWN_EXEC = "script";
  try {
    await F.frontVerify({ runId: "run-1", ref: "agt-1", key: "k" }, { what: "capcomd verify" });
    await F.frontMerge({ runId: "run-1", ref: "agt-1", require: "vfy-1" }, { what: "capcomd merge" });
    await F.frontDecide("run-1", "mrg-1", { approve: true, by: "cli" }, { what: "capcomd approve" });
  } finally { delete process.env.CAPCOMD_SPAWN_EXEC; }
  const agentsFile = resolve(process.cwd(), ".capcomd", "agents.json");
  expect(sent.map((s) => s.path)).toEqual(["/v1/runs/run-1/verifications", "/v1/runs/run-1/merges", "/v1/runs/run-1/merges/mrg-1/decision"]);
  for (const s of sent) expect(s.body.driveEnv).toMatchObject({ CAPCOMD_AGENTS_FILE: agentsFile, CAPCOMD_SPAWN_EXEC: "script" });
  // Only drive settings: never the engine's endpoint or a secret.
  for (const s of sent) expect(Object.keys(s.body.driveEnv)).not.toContain("CAPCOMD_ENDPOINT");
});
