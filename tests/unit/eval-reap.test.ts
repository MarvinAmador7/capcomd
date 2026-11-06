// scripts/reap.ts: what an eval kills when it ends. A process left running from its scratch folder goes; the eval itself
// doesn't, even when its own command line names the folder (`--work DIR`): the team-shape eval used to SIGKILL itself
// there, ending with exit 137 before it deleted or reported keeping the folder.
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REAP = new URL("../../scripts/reap.ts", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "eval-reap-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

test("reapUnder kills what runs from the folder, not the eval whose command line names it", async () => {
  // A leftover: its command line names a path in the folder.
  const left = spawn("sh", ["-c", `sleep 30; : ${work}/agent`], { stdio: "ignore" });
  const gone = new Promise<string | null>((r) => left.on("exit", (_c, sig) => r(sig)));
  await Bun.sleep(200);
  // The eval, started with --work <folder>/… on its command line, reaps on its way out.
  const evalProc = spawnSync(process.execPath, ["-e", `const { reapUnder } = await import(${JSON.stringify(REAP)}); console.log(JSON.stringify(reapUnder(process.env.WORK)))`, "--work", `${work}/`], { encoding: "utf8", env: { ...process.env, WORK: work } });
  expect(evalProc.signal).toBeNull();
  expect(evalProc.status).toBe(0);
  expect(JSON.parse(evalProc.stdout.trim())).toContain(left.pid);
  expect(await gone).toBe("SIGKILL");
});
