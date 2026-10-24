// `capcomd tui`: the terminal debugger ships with the CLI (and the single executable) and takes its own flags.
import { expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const run = (args: string[]) => {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], { env: { ...process.env, CAPCOMD_HOME: mkdtempSync(join(tmpdir(), "capcomd-tui-")) }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

test("capcomd tui --help is the debugger's own help, not the CLI's", () => {
  const r = run(["tui", "--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("capcomd tui — watch and debug a capcomd run");
  expect(r.out).toContain("--view live|waterfall|timeline|rollups|events|replay");
});

test("capcomd tui with no runs says how to start one", () => {
  const r = run(["tui"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("capcomd tui: no runs yet");
});
