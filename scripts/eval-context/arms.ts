// The context eval's arms (ADR-025 §12 ablations): what an agent gets beyond the task and the repository. Step 0 runs the
// two baselines; the others are listed with the build step that makes them runnable, so the matrix is one table and an
// arm becomes available by giving it `files` (and a profile `context` block) in the step that ships it.
//
// Step 6's questions (§6.1, §6.3) are asked before anything is built: inline items and triggered injection are arms
// the harness delivers itself, the way the kernel would (`inline`: the brief's first k items, whole and fenced, in the
// agent's first message; `triggered`: an item pushed, fenced, as a message the first time the agent touches a path it
// applies to), and each ships only if report.ts `admission` admits it on a current model.
import type { ContextSpec } from "../../packages/plugin/src/context-layer";
import { agentsMd, contextFiles, type World } from "./world";

export interface Arm {
  name: string;
  what: string;
  /** Files the arm adds to the repository (on top of the same base for every arm). */
  files?: (w: World) => Record<string, string>;
  /** The `context` block of the arm's profile: what the router briefs its agents from (ADR-025 §10). */
  context?: ContextSpec;
  /** Inline items (§6.1, D4): the brief's first k items in full, fenced, in the agent's first message. */
  inline?: number;
  /** Triggered injection (§6.3): an item pushed as a fenced message the first time the agent touches one of its paths. */
  triggered?: boolean;
  /** The agent providers the arm can be delivered to (all when absent): a Codex agent can't read a message while it runs. */
  providers?: ReadonlyArray<"claude" | "codex">;
  /** The arm it is judged against (report.ts `admission`). */
  against?: string;
  /** Not runnable yet: the ADR-025 build step that adds what it needs. */
  needs?: string;
}

const INDEX: ContextSpec = { providers: [{ name: "memory" }] };
/** The project's context without the `paths` an item applies to: the brief's paths column left out. */
const withoutPaths = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([p, s]) => [p, s.replace(/^paths:\n(?:\s*- .*\n)+/m, "").replace(/^paths: .*\n/m, "")]));

export const ARMS: readonly Arm[] = [
  { name: "none", what: "the task and the repository, nothing else", files: () => ({}) },
  // Codex reads AGENTS.md itself; Claude Code reads CLAUDE.md, so the arm has the one-line import a project adds for it.
  { name: "agents-md", what: "an AGENTS.md a careful team keeps (conventions, current business rules, decision log), imported by CLAUDE.md", files: (w) => ({ "AGENTS.md": agentsMd(w), "CLAUDE.md": "@AGENTS.md\n" }) },
  // The same records as agents-md, as the project's own facts, plus two memory lessons: the brief lists them (index lines
  // only, superseded records left out) and the agent opens the files it needs.
  { name: "index", what: "the router's brief over hand-written .capcomd/context/ (index lines only)", files: (w) => contextFiles(w), context: INDEX },
  { name: "index-paths", what: "the brief without the paths column (no item says which paths it applies to), against index", files: (w) => withoutPaths(contextFiles(w)), context: INDEX, against: "index" },
  { name: "index-k1", what: "the brief plus its first item in full, fenced, in the agent's first message (inline k = 1)", files: (w) => contextFiles(w), context: INDEX, inline: 1, against: "index" },
  { name: "index-k3", what: "the brief plus its first three items in full (inline k = 3)", files: (w) => contextFiles(w), context: INDEX, inline: 3, against: "index" },
  { name: "index-triggered", what: "the brief, and each item pushed as a fenced message the first time the agent touches a path it applies to (triggered injection)", files: (w) => contextFiles(w), context: INDEX, triggered: true, providers: ["claude"], against: "index" },
  { name: "memory", what: "context-memory with capture and consolidation", needs: "ADR-025 steps 2-3" },
  { name: "memory-groundray", what: "context-memory plus the company brain through context-groundray", needs: "ADR-025 step 4" },
];

export const armNamed = (name: string) => ARMS.find((a) => a.name === name) ?? null;
