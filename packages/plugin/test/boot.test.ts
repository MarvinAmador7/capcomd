// `testkit.bootWith` (src/boot.ts, spec §14.3): the daemon it boots gets none of what would point it at the developer's
// own capcomd, logins or repository; and its wait for the plugins, against a stand-in `capcomd` that serves /v1/health
// and the plugin's state on the harness socket. The boot itself, against a real daemon, is
// tests/scenarios/plugin-slack-example.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootWith, cleanEnv } from "../src/boot";

describe("bootWith's environment (§14.3)", () => {
  test("keeps the caller's PATH and the rest; drops capcomd's, its engine's, boxd's, GitHub tokens and git's", () => {
    const env = {
      PATH: "/usr/bin", HOME: "/Users/dev", BUN_OPTIONS: "--preload x", ANTHROPIC_API_KEY: "kept: no agent runs",
      CAPCOMD_HOME: "/Users/dev/.capcomd", CAPCOMD_ENDPOINT: "http://127.0.0.1:6420", RELAY_RPC_KEY_FILE: "k",
      RIVET_ENDPOINT: "e", RIVETKIT_STORAGE_PATH: "s", BOXD_API_KEY: "b", GITHUB_TOKEN: "g", GH_TOKEN: "h",
      // A test run from a git hook (husky and the like): git exports where the developer's repository is.
      GIT_DIR: "/Users/dev/app/.git", GIT_WORK_TREE: "/Users/dev/app", GIT_INDEX_FILE: "/Users/dev/app/.git/index",
      UNSET: undefined,
    };
    expect(cleanEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/Users/dev", BUN_OPTIONS: "--preload x", ANTHROPIC_API_KEY: "kept: no agent runs" });
  });
});

describe("bootWith's wait for the plugins (§14.3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cpk-fake-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A stand-in capcomd: `clients add` prints a token; `serve` answers /v1/health, and GET /v1/plugins/{name} with
  // FAKE_PLUGIN, on the harness socket, and writes when it first answered the latter to FAKE_SEEN.
  const fake = join(dir, "capcomd.ts");
  writeFileSync(fake, `import { existsSync, writeFileSync } from "node:fs";
const [cmd] = process.argv.slice(2);
if (cmd === "clients") console.log(JSON.stringify({ token: "tok" }));
if (cmd === "serve") {
  const srv = Bun.serve({ unix: process.env.CAPCOMD_HARNESS_SOCKET, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/v1/health") return Response.json({ ok: true });
    if (!path.startsWith("/v1/plugins/")) return Response.json({ code: "not_found" }, { status: 404 });
    if (!existsSync(process.env.FAKE_SEEN)) writeFileSync(process.env.FAKE_SEEN, String(Date.now()));
    return Response.json(JSON.parse(process.env.FAKE_PLUGIN));
  } });
  process.on("SIGTERM", () => { srv.stop(true); process.exit(0); });
}
`);
  const example = join(import.meta.dir, "..", "examples", "slack-notifier");
  let n = 0;
  /** Boot the example against the stand-in reporting `plugin`: the boot's error, and how long after the first report it
   *  settled. */
  async function boot(plugin: Record<string, unknown>, fn: () => Promise<void> = async () => {}) {
    const seen = join(dir, `seen-${++n}`);
    let error: Error | null = null;
    try {
      await bootWith([{ dir: example }], fn, {
        capcomd: [process.execPath, fake], port: 10875, readyMs: 8_000,
        env: { FAKE_PLUGIN: JSON.stringify({ name: "slack-notifier", ...plugin }), FAKE_SEEN: seen },
      });
    } catch (e) { error = e as Error; }
    return { error, afterMs: existsSync(seen) ? Date.now() - Number(readFileSync(seen, "utf8")) : null };
  }

  test("a disabled plugin fails the boot within a second, naming its state, instead of waiting out readyMs", async () => {
    // As the daemon holds one with `enabled: false`: at validated, cause disabled.
    const held = await boot({ state: "validated", enabled: false, cause: "disabled" });
    expect(held.error?.message).toMatch(/^the slack-notifier plugin is validated \(disabled\); it is off \(plugins\.slack-notifier\.enabled is false/);
    expect(held.afterMs).toBeLessThan(1000);
    // `enabled: false` from a daemon that gives no cause, and one disabled after it was active (disposed).
    const plain = await boot({ state: "validated", enabled: false, cause: null });
    expect(plain.error?.message).toMatch(/^the slack-notifier plugin is validated \(disabled\); it is off/);
    expect(plain.afterMs).toBeLessThan(1000);
    const disposed = await boot({ state: "disposed", enabled: false, cause: "disabled" });
    expect(disposed.error?.message).toMatch(/^the slack-notifier plugin is disposed \(disabled\); it is off/);
    expect(disposed.afterMs).toBeLessThan(1000);
    // Disposed with a cause of its own (its dispose timed out): named by that cause, not as disabled.
    const timedOut = await boot({ state: "disposed", enabled: false, cause: "dispose_timeout" });
    expect(timedOut.error?.message).toMatch(/^the slack-notifier plugin is disposed \(dispose_timeout\):\n/);
    expect(timedOut.afterMs).toBeLessThan(1000);
  }, 60_000);

  test("an untrusted plugin is named by its cause, not as disabled; an active one runs the test", async () => {
    const untrusted = await boot({ state: "validated", enabled: false, cause: "untrusted" });
    expect(untrusted.error?.message).toMatch(/^the slack-notifier plugin is validated \(untrusted\):\n/);
    let ran = false;
    const active = await boot({ state: "active", enabled: true, cause: null }, async () => { ran = true; });
    expect([active.error, ran]).toEqual([null, true]);
  }, 60_000);
});
