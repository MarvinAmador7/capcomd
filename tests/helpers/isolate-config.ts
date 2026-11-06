// bunfig.toml preload for `bun test`: never apply the developer's own ~/.capcomd/config.json or a project
// .capcomd/config.json (e.g. CAPCOMD_SANDBOX=boxd from `capcomd setup`) to the CLIs and engines tests start; never reach
// their daemon (127.0.0.1:6420) and never write under their ~/.capcomd (./guard.ts enforces both).
// `bun test --isolate` (the package.json scripts, CI) runs this preload again for every file: everything below is per file.
import { afterAll, mock } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { privateHarnessSocket } from "./harness-socket";
import { installGuard, REAL_CAPCOMD_HOME } from "./guard";

process.env.CAPCOMD_NO_CONFIG = "1";
// Nor bind the developer's harness socket (~/.capcomd/harness.sock, or one from their environment): every `capcomd
// serve` a test starts inherits a private one unless the test (or tests/helpers/test-engine.ts, per engine) sets its own.
process.env.CAPCOMD_HARNESS_SOCKET = privateHarnessSocket();
// A scratch CAPCOMD_HOME of this file's own, whatever the environment had (the developer's real one, or one shared by the
// whole run): everything capcomd keeps in its home (state/, traces/, the engine's data, engine.log, harness-state.json,
// config.json, the project list) lands there, and state one file leaves can't fail another. Tests that need a home of
// their own still set one.
const scratch = mkdtempSync(join(tmpdir(), "capcomd-test-home-"));
process.env.CAPCOMD_HOME = scratch;
// The host's token signing key is read from ~/.capcomd/rpc.key whatever CAPCOMD_HOME says (src/subagents/token.ts).
process.env.CAPCOMD_RPC_KEY_FILE ??= join(scratch, "rpc.key");
// No endpoint means the default, a developer's daemon on :6420: a test that forgets its own engine gets a closed port
// instead (the discard port; nothing listens there) and fails as "engine unreachable". And nothing starts an engine for
// it there: `capcomd mcp` starts one when nothing answers (src/core/engine-start.ts), detached, outliving the test. The
// test of that autostart (tests/core/engine-start.test.ts) turns it back on for itself.
process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9";
process.env.CAPCOMD_NO_ENGINE_AUTOSTART = "1";
// Nor ask the developer's own GitHub CLI (it reads its login from the keychain): the forges ask gh only through
// CAPCOMD_GH_CLI, so a test that needs gh names its fake there. The live GitHub test (CAPCOMD_GH_LIVE=1) keeps the real one.
if (process.env.CAPCOMD_GH_LIVE !== "1") process.env.CAPCOMD_GH_CLI ??= "/nonexistent/capcomd-test-gh";

// The guard, here and in every bun process a test starts (BUN_OPTIONS: bun reads it as command-line flags).
const log = join(scratch, "guard-violations.log");
process.env.CAPCOMD_TEST_GUARD_LOG = log;
process.env.CAPCOMD_TEST_REAL_HOME = REAL_CAPCOMD_HOME;
const child = `--preload ${new URL("./guard-child.ts", import.meta.url).pathname}`;
if (!(process.env.BUN_OPTIONS ?? "").includes(child)) process.env.BUN_OPTIONS = `${process.env.BUN_OPTIONS ?? ""} ${child}`.trim();
const patched = installGuard();
// Named imports (`import { writeFileSync } from "fs"`) bind the module's functions when they load: give them the guarded ones.
for (const id of ["fs", "node:fs"]) mock.module(id, () => ({ ...patched.fs, default: patched.fs }));
for (const id of ["fs/promises", "node:fs/promises"]) mock.module(id, () => ({ ...patched.promises, default: patched.promises }));
// What a child (or code that swallowed the error) did fails the file.
afterAll(() => {
  const seen = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  if (seen.length) throw new Error(`test isolation violated (tests/helpers/guard.ts):\n${[...new Set(seen)].join("\n")}`);
});
