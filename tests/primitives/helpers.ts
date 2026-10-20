import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function primitivesAgentsFile() {
  const p = join(mkdtempSync(join(tmpdir(), "capcomd-prim-agents-")), "agents.json");
  writeFileSync(p, JSON.stringify({
    schema: "capcomd.agents/v1",
    agents: {
      sup: { provider: "claude", auth: "subscription", maxTurns: 40, children: { allowSpawn: true, maxDepth: 2, maxChildren: 2, maxTotalDescendants: 4, allowedChildProfiles: ["coder"], budgetShare: 0.5 } },
      coder: { provider: "claude", auth: "subscription", maxTurns: 20 },
    },
  }));
  return p;
}
