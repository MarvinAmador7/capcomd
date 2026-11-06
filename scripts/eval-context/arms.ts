// The context eval's arms (ADR-025 §12 ablations): what an agent gets beyond the task and the repository. Step 0 runs the
// two baselines; the others are listed with the build step that makes them runnable, so the matrix is one table and an
// arm becomes available by giving it `files` (and a profile `context` block) in the step that ships it.
import type { ContextSpec } from "../../packages/plugin/src/context-layer";
import { agentsMd, contextFiles, type World } from "./world";

export interface Arm {
  name: string;
  what: string;
  /** Files the arm adds to the repository (on top of the same base for every arm). */
  files?: (w: World) => Record<string, string>;
  /** The `context` block of the arm's profile: what the router briefs its agents from (ADR-025 §10). */
  context?: ContextSpec;
  /** Not runnable yet: the ADR-025 build step that adds what it needs. */
  needs?: string;
}

export const ARMS: readonly Arm[] = [
  { name: "none", what: "the task and the repository, nothing else", files: () => ({}) },
  // Codex reads AGENTS.md itself; Claude Code reads CLAUDE.md, so the arm has the one-line import a project adds for it.
  { name: "agents-md", what: "an AGENTS.md a careful team keeps (conventions, current business rules, decision log), imported by CLAUDE.md", files: (w) => ({ "AGENTS.md": agentsMd(w), "CLAUDE.md": "@AGENTS.md\n" }) },
  // The same records as agents-md, as the project's own facts, plus two memory lessons: the brief lists them (index lines
  // only, superseded records left out) and the agent opens the files it needs.
  { name: "index", what: "the router's brief over hand-written .capcomd/context/ (index lines only)", files: (w) => contextFiles(w), context: { providers: [{ name: "memory" }] } },
  { name: "index-paths", what: "the brief without the paths column, against index (the paths ablation)", needs: "ADR-025 step 6 (§12's paths ablation: a router switch that leaves the paths column out)" },
  { name: "index-k1", what: "the brief plus one inline item as a fenced first message", needs: "ADR-025 step 6" },
  { name: "index-k3", what: "the brief plus three inline items", needs: "ADR-025 step 6" },
  { name: "memory", what: "context-memory with capture and consolidation", needs: "ADR-025 steps 2-3" },
  { name: "memory-groundray", what: "context-memory plus the company brain through context-groundray", needs: "ADR-025 step 4" },
];

export const armNamed = (name: string) => ARMS.find((a) => a.name === name) ?? null;
