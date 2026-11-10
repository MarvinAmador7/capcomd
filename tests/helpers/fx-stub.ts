// A stand-in for capcomd's own fx install (`<agent home>/bin/fx` at the pinned version, src/plugins/agent-fx.ts) in a test
// "VM": an env build installs every active provider's CLI that is missing, and fx's install downloads its release
// archive. A test's VM has it already, so no test downloads it (or runs it on the host).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FX_VERSION } from "../../src/plugins/agent-fx";

export function stubFx(home: string): void {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "fx"), `#!/bin/sh\necho ${FX_VERSION}\n`);
  chmodSync(join(home, "bin", "fx"), 0o755);
}
