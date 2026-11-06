// The context eval's arms (ADR-025 §12 ablations): what an agent gets beyond the task and the repository. Step 0 runs the
// two baselines; the others are listed with the build step that makes them runnable, so the matrix is one table and an
// arm becomes available by giving it `files` (or a profile `context` block) in the step that ships it.
import { agentsMd, type World } from "./world";

export interface Arm {
  name: string;
  what: string;
  /** Files the arm adds to the repository (on top of the same base for every arm). */
  files?: (w: World) => Record<string, string>;
  /** Not runnable yet: the ADR-025 build step that adds what it needs. */
  needs?: string;
}

export const ARMS: readonly Arm[] = [
  { name: "none", what: "the task and the repository, nothing else", files: () => ({}) },
  // Codex reads AGENTS.md itself; Claude Code reads CLAUDE.md, so the arm has the one-line import a project adds for it.
  { name: "agents-md", what: "an AGENTS.md a careful team keeps (conventions, current business rules, decision log), imported by CLAUDE.md", files: (w) => ({ "AGENTS.md": agentsMd(w), "CLAUDE.md": "@AGENTS.md\n" }) },
  { name: "index", what: "the router's brief over hand-written .capcomd/context/ (index lines only)", needs: "ADR-025 step 1 (envelope + router)" },
  { name: "index-paths", what: "the brief with the paths column", needs: "ADR-025 step 1" },
  { name: "index-k1", what: "the brief plus one inline item as a fenced first message", needs: "ADR-025 step 6" },
  { name: "index-k3", what: "the brief plus three inline items", needs: "ADR-025 step 6" },
  { name: "memory", what: "context-memory with capture and consolidation", needs: "ADR-025 steps 2-3" },
  { name: "memory-groundray", what: "context-memory plus the company brain through context-groundray", needs: "ADR-025 step 4" },
];

export const armNamed = (name: string) => ARMS.find((a) => a.name === name) ?? null;
