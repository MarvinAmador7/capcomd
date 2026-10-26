// bunfig.toml preload for `bun test`: never apply the developer's own ~/.capcomd/config.json or a project
// .capcomd/config.json (e.g. CAPCOMD_SANDBOX=boxd from `capcomd setup`) to the CLIs and engines tests start.
import { privateHarnessSocket } from "./harness-socket";

process.env.CAPCOMD_NO_CONFIG = "1";
// Nor bind the developer's harness socket (~/.capcomd/harness.sock, or one from their environment): every `capcomd
// serve` a test starts inherits a private one unless the test (or tests/chaos/engine.ts, per engine) sets its own.
process.env.CAPCOMD_HARNESS_SOCKET = privateHarnessSocket();
