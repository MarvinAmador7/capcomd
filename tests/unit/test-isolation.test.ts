// The test isolation guard (tests/helpers/guard.ts, installed by the bunfig preload): no test reaches a developer's
// daemon on 127.0.0.1:6420/6421/6430 or writes under their real ~/.capcomd, in the test's process or in a bun process
// it starts. Its behaviour is shown on a harmless port and directory of this test's own (CAPCOMD_TEST_GUARD_PORTS /
// _DIRS), so a broken guard can't reach the real ones from here; the real ones are checked to be on its lists.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { writeFile } from "fs/promises";
import * as fsp from "node:fs/promises";
import net from "net";
import http from "node:http";
import { tmpdir, userInfo } from "os";
import { join, resolve } from "path";
import { FORBIDDEN_PORTS, GUARDED, REAL_CAPCOMD_HOME, forbiddenPorts, guardedRoots, takeViolations } from "../helpers/guard";
import { testPort } from "../helpers/engine";
import { endpoint } from "../../src/core/relay";
import { capcomdHome } from "../../src/utils/home";

const dir = mkdtempSync(join(tmpdir(), "capcomd-guard-"));
const fence = join(dir, "fence"); // stands in for the real ~/.capcomd
mkdirSync(fence);
const accepted: string[] = [];
let port = 0;
let server: net.Server | null = null;
const probe = async () => {
  port = await testPort();
  process.env.CAPCOMD_TEST_GUARD_PORTS = String(port);
  process.env.CAPCOMD_TEST_GUARD_DIRS = fence;
  // Anything that reaches this listener got past the guard.
  server = net.createServer((s) => { accepted.push("connection"); s.destroy(); });
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
};
afterAll(() => {
  server?.close();
  delete process.env.CAPCOMD_TEST_GUARD_PORTS;
  delete process.env.CAPCOMD_TEST_GUARD_DIRS;
  takeViolations(); // this file's are deliberate
});

test("the preload gives every test file a scratch home, a closed endpoint and no engine autostart", () => {
  const home = process.env.CAPCOMD_HOME!;
  expect(home).toBeTruthy();
  expect(resolve(home).startsWith(resolve(tmpdir())) || resolve(home).startsWith("/tmp") || resolve(home).startsWith("/private/")).toBe(true);
  expect(capcomdHome()).not.toBe(REAL_CAPCOMD_HOME);
  expect(FORBIDDEN_PORTS as readonly number[]).not.toContain(Number(new URL(endpoint()).port));
  expect(process.env.CAPCOMD_NO_ENGINE_AUTOSTART).toBe("1");
  expect(process.env.CAPCOMD_RPC_KEY_FILE?.startsWith(home)).toBe(true);
  expect(process.env.BUN_OPTIONS).toContain("tests/helpers/guard-child.ts");
});

test("the guard covers a developer's daemon ports and their real ~/.capcomd", () => {
  expect(forbiddenPorts()).toEqual(expect.arrayContaining([6420, 6421, 6430]));
  expect(REAL_CAPCOMD_HOME).toBe(join(userInfo().homedir, ".capcomd"));
  expect(guardedRoots()).toContain(REAL_CAPCOMD_HOME);
});

test("fetch to :6420 is refused before it connects", async () => {
  // Only with the guard in place (else this would ask a developer's daemon).
  expect((globalThis.fetch as any)[GUARDED]).toBe(true);
  for (const p of FORBIDDEN_PORTS) {
    const e: any = await fetch(`http://127.0.0.1:${p}/metadata`).catch((x) => x);
    expect(String(e?.message)).toContain("test isolation");
  }
  expect(takeViolations().length).toBe(FORBIDDEN_PORTS.length);
});

test("in this process: fetch, WebSocket, net and http to a forbidden port never connect", async () => {
  await probe();
  expect(String((await fetch(`http://127.0.0.1:${port}/`).catch((x) => x))?.message)).toContain("test isolation");
  expect(() => new WebSocket(`ws://localhost:${port}/`)).toThrow("test isolation");
  expect(() => net.connect(port, "127.0.0.1")).toThrow("test isolation");
  expect(() => net.createConnection({ port, host: "localhost" })).toThrow("test isolation");
  // node:http connects on a later tick: the request fails instead of throwing.
  const viaHttp = await new Promise<unknown>((r) => { try { http.get(`http://127.0.0.1:${port}/`, () => r("answered")).on("error", r); } catch (e) { r(e); } });
  expect(String((viaHttp as Error)?.message)).toContain("test isolation");
  await Bun.sleep(200);
  expect(accepted).toEqual([]);
  expect(takeViolations().length).toBe(5);
});

test("in this process: writes under the guarded home are refused before they happen", async () => {
  const f = join(fence, "probe.json");
  expect(() => writeFileSync(f, "{}")).toThrow("test isolation");
  expect(() => mkdirSync(join(fence, "engine", "6420"), { recursive: true })).toThrow("test isolation");
  expect(String((await writeFile(f, "{}").catch((x) => x))?.message)).toContain("test isolation");
  expect(String((await fsp.mkdir(join(fence, "d")).catch((x) => x))?.message)).toContain("test isolation");
  expect(() => Bun.write(f, "{}")).toThrow("test isolation");
  expect(existsSync(f) || existsSync(join(fence, "engine")) || existsSync(join(fence, "d"))).toBe(false);
  // Reading is fine, and so is writing anywhere else.
  writeFileSync(join(dir, "ok.json"), "{}");
  expect(takeViolations().length).toBe(5);
});

test("in a bun process a test starts: the same guard, recorded for the file even when the child swallows the error", async () => {
  if (!server) await probe();
  const script = join(dir, "child.ts");
  writeFileSync(script, [
    `import { writeFileSync } from "fs";`,
    `await fetch("http://127.0.0.1:${port}/").catch(() => {});`,
    `try { require("fs").writeFileSync(${JSON.stringify(join(fence, "child.json"))}, "{}"); } catch {}`,
    `console.log("child ran");`,
  ].join("\n"));
  const r = Bun.spawnSync([process.execPath, script], { env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(r.stdout.toString()).toContain("child ran");
  await Bun.sleep(200);
  expect(accepted).toEqual([]);
  expect(existsSync(join(fence, "child.json"))).toBe(false);
  const seen = takeViolations();
  expect(seen.some((l) => l.includes(`fetch http://127.0.0.1:${port}/`))).toBe(true);
  expect(seen.some((l) => l.includes(join(fence, "child.json")))).toBe(true);
});

test("a capcomd started on the real ~/.capcomd (no CAPCOMD_HOME, the real HOME) is recorded", () => {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: userInfo().homedir };
  delete env.CAPCOMD_HOME;
  // A stand-in at a capcomd CLI's path that does nothing (the real CLI isn't run on the real home, even here): the
  // guard records the home it starts with.
  mkdirSync(join(dir, "src", "cli"), { recursive: true });
  writeFileSync(join(dir, "src", "cli", "index.ts"), `console.log("stand-in");\n`);
  Bun.spawnSync([process.execPath, join(dir, "src", "cli", "index.ts"), "status"], { env, stdout: "pipe", stderr: "pipe" });
  expect(takeViolations().some((l) => l.includes("started with the real"))).toBe(true);
});
