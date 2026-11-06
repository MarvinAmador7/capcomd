// The profiles `capcomd setup project` writes for some answers, as an agent is pinned with them: the plan written into
// its checkout (profile files that extend each other, ADR-024 §6) and read back, each resolved to its flat spec.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planProject, writeProject, type ProjectAnswers } from "../../src/config/project-setup";
import { readProfiles, type AgentSpec } from "../../src/profiles";

export function setupProfiles(a: ProjectAnswers): { plan: ReturnType<typeof planProject>; specs: Record<string, AgentSpec> } {
  const plan = planProject(a);
  const env = { CAPCOMD_HOME: mkdtempSync(join(tmpdir(), "capcomd-setup-home-")) };
  writeProject(plan, { env });
  return { plan, specs: readProfiles(plan.agentsPath, env).agents };
}
