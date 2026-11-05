// bunfig.toml preload for `bun test`: never apply the developer's own ~/.capcomd/config.json or a project
// .capcomd/config.json (e.g. CAPCOMD_SANDBOX=boxd from `capcomd setup`) to the CLIs and engines tests start.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { privateHarnessSocket } from "./harness-socket";

process.env.CAPCOMD_NO_CONFIG = "1";
// Nor bind the developer's harness socket (~/.capcomd/harness.sock, or one from their environment): every `capcomd
// serve` a test starts inherits a private one unless the test (or tests/helpers/test-engine.ts, per engine) sets its own.
process.env.CAPCOMD_HARNESS_SOCKET = privateHarnessSocket();
// Nor share one CAPCOMD_HOME (a developer's real one, or a scratch home set for the whole run): state one file leaves
// there (the project list, settings, machine ledgers) fails another. The tests isolate themselves without one (temp
// dirs, the checkout's .relay/, their own ports), as CI runs them; an inherited one is replaced by a fresh temp dir.
// `bun test --isolate` (the package.json scripts, CI) runs this preload again for every file: one home per file.
if (process.env.CAPCOMD_HOME) process.env.CAPCOMD_HOME = mkdtempSync(join(tmpdir(), "capcomd-test-home-"));
// Nor ask the developer's own GitHub CLI (it reads its login from the keychain): the forges ask gh only through
// CAPCOMD_GH_CLI, so a test that needs gh names its fake there. The live GitHub test (CAPCOMD_GH_LIVE=1) keeps the real one.
if (process.env.CAPCOMD_GH_LIVE !== "1") process.env.CAPCOMD_GH_CLI ??= "/nonexistent/capcomd-test-gh";
