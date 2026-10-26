// A private harness.v1 socket path for anything a test starts. `capcomd serve` otherwise binds the default
// ~/.capcomd/harness.sock, which is the developer's own daemon's socket. Short on purpose: a Unix socket path must
// stay under ~104 bytes (macOS), and tmpdir() there is already ~50.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function privateHarnessSocket(): string {
  return join(mkdtempSync(join(tmpdir(), "cch-")), "h.sock");
}

/** Leave a dead daemon's socket at `path`: a process binds it and exits without cleaning up (as a SIGKILL would). */
export function staleSocket(path: string): void {
  const r = Bun.spawnSync([process.execPath, "-e", `Bun.serve({ unix: ${JSON.stringify(path)}, fetch: () => new Response("") }); process.exit(0);`]);
  if (r.exitCode !== 0) throw new Error(`could not leave a stale socket at ${path}: ${r.stderr.toString()}`);
}
