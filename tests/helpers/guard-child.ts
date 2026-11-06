// The test isolation guard in every bun process a test starts (tests/helpers/isolate-config.ts puts this in
// BUN_OPTIONS as a --preload): see ./guard.ts.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installGuard, REAL_CAPCOMD_HOME, violation } from "./guard";

installGuard();
// A capcomd started on the real ~/.capcomd (a test dropped CAPCOMD_HOME and kept the real HOME) would keep its state,
// engine data and logs there: recorded (the test file fails), not thrown, so the test still shows what it was doing.
if (/src\/cli\/index\.ts$/.test(process.argv[1] ?? "")) {
  const home = process.env.CAPCOMD_HOME ? resolve(process.env.CAPCOMD_HOME) : join(process.env.HOME || homedir(), ".capcomd");
  if (home === REAL_CAPCOMD_HOME) violation(`capcomd ${process.argv.slice(2, 4).join(" ")} started with the real ${REAL_CAPCOMD_HOME} as its home (no CAPCOMD_HOME)`);
}
