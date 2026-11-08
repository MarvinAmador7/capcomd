// scripts/reap.ts: what an eval kills when it ends. A process left running from its scratch folder goes; the eval itself
// doesn't, even when its own command line names the folder (`--work DIR`): the team-shape eval used to SIGKILL itself
// there, ending with exit 137 before it deleted or reported keeping the folder. Nor does whatever started it, though its
// command line names the folder too (a shell running `timeout … bun scripts/eval-team-shape.ts --work DIR`).
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REAP = new URL("../../scripts/reap.ts", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "eval-reap-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const EVAL = `const { reapUnder } = await import(process.env.REAP); console.log(JSON.stringify(reapUnder(process.env.WORK)))`;

/** A leftover: one process (nothing behind it once it's killed) whose command line names a path in the folder. */
function leftover() {
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", `${work}/agent`], { stdio: "ignore" });
  return { pid: p.pid!, gone: new Promise<string | null>((r) => p.on("exit", (_c, sig) => r(sig))) };
}

test("reapUnder kills what runs from the folder, not the eval whose command line names it", async () => {
  const left = leftover();
  await Bun.sleep(200);
  // The eval, started with --work <folder>/… on its command line, reaps on its way out.
  const evalProc = spawnSync(process.execPath, ["-e", EVAL, "--work", `${work}/`], { encoding: "utf8", env: { ...process.env, REAP, WORK: work } });
  expect(evalProc.signal).toBeNull();
  expect(evalProc.status).toBe(0);
  expect(JSON.parse(evalProc.stdout.trim())).toContain(left.pid);
  expect(await left.gone).toBe("SIGKILL");
});

test("reapUnder spares every process the eval descends from, not only its parent", async () => {
  const left = leftover();
  await Bun.sleep(200);
  // sh (names the folder) → sh (names it) → the eval (--work <folder>/): both shells outlive the reaping and the outer
  // one goes on to its next command.
  const inner = `${process.execPath} -e "$EVAL" --work ${work}/; true`;
  const r = spawnSync("sh", ["-c", `sh -c '${inner}'; echo after ${work}/`], { encoding: "utf8", env: { ...process.env, EVAL, REAP, WORK: work } });
  expect(r.signal).toBeNull();
  expect(r.status).toBe(0);
  const [killed, after] = r.stdout.trim().split("\n");
  expect(JSON.parse(killed!)).toEqual([left.pid]);
  expect(after).toBe(`after ${work}/`);
  expect(await left.gone).toBe("SIGKILL");
});

test("the team-shape eval refuses a --work folder that holds anything (it deletes the folder at the end)", () => {
  // As the context eval does: with the self-kill gone, `--work ~/somewhere` would reach the eval's rmSync.
  const mine = mkdtempSync(join(tmpdir(), "eval-reap-mine-"));
  try {
    writeFileSync(join(mine, "notes.txt"), "keep me");
    const script = new URL("../../scripts/eval-team-shape.ts", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [script, "--work", mine, "--port", "8818", "--claude", "/nonexistent"], { encoding: "utf8", timeout: 30_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`--work ${mine} isn't empty`);
    expect(readFileSync(join(mine, "notes.txt"), "utf8")).toBe("keep me");
  } finally { rmSync(mine, { recursive: true, force: true }); }
});
