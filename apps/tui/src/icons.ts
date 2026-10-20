import type { Span } from "./adapters/types";
import { c } from "./theme";

/** What a span *is*. One symbol per kind and one per status; they never share a glyph. */
export type SpanKind = "agent" | "llm" | "tool" | "git" | "sandbox" | "approval" | "run" | "state";
export type IconStatus = "ok" | "error" | "wait" | "running";
export type IconSet = "glyph" | "nerd" | "minimal" | "none" | "glyph-b" | "glyph-v1";
/** glyph-b and glyph-v1 are kept for comparison (scripts/glyph-compare.tsx). */
export const ICON_SETS: IconSet[] = ["glyph", "nerd", "minimal", "none", "glyph-b", "glyph-v1"];

export function kindOf(s: Pick<Span, "name" | "attrs">): SpanKind {
  const n = s.name;
  if (/approval|await/.test(n)) return "approval";
  if (/^(gen_ai|llm)\.|\.turn\b/.test(n) || (s.attrs["gen_ai.request.model"] !== undefined && !n.startsWith("agent."))) return "llm";
  if (/^tool\.|\.tool\b|^mcp\./.test(n)) return "tool";
  if (n.startsWith("agent.")) return "agent";
  if (n.startsWith("git.")) return "git";
  if (n.startsWith("sandbox.")) return "sandbox";
  if (n === "relay.run" || /^actor\.(run|planner)\./.test(n) || n === "transition.run") return "run";
  return "state"; // other actor calls and state transitions: bookkeeping
}

interface Set_ { kind: Record<SpanKind, string>; status: Record<IconStatus, string>; note: string }

export const SETS: Record<Exclude<IconSet, "none">, Set_> = {
  /**
   * Fill tells you the role: filled = an actor doing work (agent ◉, run/plan ▪), hollow = a call it
   * makes (llm ▹, tool ▫), line-drawn = infrastructure (git ⌥, sandbox ⊡, bookkeeping ∙), and ◔ is
   * the one clock. Status marks are strokes (✓ ✗ ⋯ ▸), never shapes, so they can't read as a type.
   * Every char is East-Asian-Width "N" (never double in CJK terminals) and is in both JetBrains Mono
   * and DejaVu Sans Mono, so nothing falls back to another font with a different width or baseline.
   */
  glyph: {
    kind: { agent: "◉", llm: "▹", tool: "▫", git: "⌥", sandbox: "⊡", approval: "◔", run: "▪", state: "∙" },
    status: { ok: "✓", error: "✗", wait: "⋯", running: "▸" },
    note: "Single-width Unicode, in JetBrains Mono and DejaVu Sans Mono; filled = actor, hollow = call, line = infra.",
  },
  "glyph-b": {
    kind: { agent: "▸", llm: "▹", tool: "▫", git: "⌥", sandbox: "⊟", approval: "◔", run: "▪", state: "∙" },
    status: { ok: "✓", error: "✗", wait: "⋯", running: "▴" },
    note: "Candidate B: triangles for agents and calls, squares for structure.",
  },
  "glyph-v1": {
    kind: { agent: "◆", llm: "◇", tool: "▪", git: "⎇", sandbox: "▸", approval: "◷", run: "◎", state: "·" },
    status: { ok: "✓", error: "✕", wait: "◌", running: "●" },
    note: "Previous set: ◆ ◇ ◎ · ● are ambiguous width; ⎇ ◷ are missing from JetBrains Mono.",
  },
  nerd: {
    // Nerd Fonts v3 codepoints (Font Awesome / Material Design / Octicons ranges).
    kind: { agent: "\u{F06A9}", llm: "\u{F09D1}", tool: "\uF0AD", git: "\uE725", sandbox: "\uF489", approval: "\u{F051F}", run: "\uF0E8", state: "\uF013" },
    status: { ok: "\uF00C", error: "\uF00D", wait: "\uF017", running: "\uF111" },
    note: "Needs a Nerd Font (v3). Without one these show as tofu boxes; use --icons glyph.",
  },
  minimal: {
    kind: { agent: "A", llm: "L", tool: "T", git: "G", sandbox: "S", approval: "W", run: "R", state: "∙" },
    status: { ok: "◉", error: "◉", wait: "◉", running: "◉" },
    note: "Status is a colored dot, kind is a letter. Plain ASCII except the dot.",
  },
};

/** Kind icons stay quiet (agent work keeps its accent-free grey); status carries the semantic color. */
export const kindColor = (k: SpanKind, selected: boolean) => (selected ? c.accent : k === "agent" || k === "llm" ? c.fg : k === "state" ? c.faint : c.dim);
export const statusIconColor = (s: IconStatus) => (s === "error" ? c.err : s === "wait" ? c.warn : s === "running" ? c.fg : c.ok);

export function iconStatus(errors: number, kind: SpanKind, running = false): IconStatus {
  return errors ? "error" : kind === "approval" ? "wait" : running ? "running" : "ok";
}
