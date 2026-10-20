import type { Theme } from "@/components/ui/types";
import { defaultTheme } from "@/lib/terminal-themes/default";

/**
 * One accent, used only for the thing you're looking at (active tab, selection, agent work).
 * Status colors are semantic and appear only when something actually succeeded, failed or waits.
 * Everything else is two greys, so color always means something.
 */
export const c = {
  fg: "#E6E6E6",
  dim: "#8A8F98",
  faint: "#4A4F57",
  accent: "#7AA2F7",
  ok: "#8BC48A",
  warn: "#E0B567",
  err: "#E07A7A",
} as const;

export const capcomTheme: Theme = {
  ...defaultTheme,
  name: "capcom",
  border: { color: c.faint, focusColor: c.accent, style: "round" },
  colors: {
    ...defaultTheme.colors,
    accent: c.accent, primary: c.accent, focusRing: c.accent, selection: c.accent,
    foreground: c.fg, mutedForeground: c.dim, muted: c.faint, border: c.faint, secondary: c.dim,
    success: c.ok, warning: c.warn, error: c.err, info: c.accent,
  },
};

/** Span family → color. Agents carry the accent; infrastructure stays grey. */
export const familyColor = (fam: string): string =>
  fam === "agent" ? c.accent : fam === "git" ? c.fg : fam === "relay" ? c.faint : c.dim;

export const statusColor = (s: string): string =>
  /fail|error|cancel/.test(s) ? c.err : /await|pending|stuck|block/.test(s) ? c.warn : /done|ok|complet|merged|success/.test(s) ? c.ok : /run|exec|leas/.test(s) ? c.accent : c.dim;

/** Status marks from the approved glyph set (single-width, East-Asian-Width N). */
export const statusGlyph = (s: string): string =>
  /fail|error/.test(s) ? "✗" : /cancel|reap/.test(s) ? "⊘" : /await|block|pending_approval/.test(s) ? "⋯" : /done|complet|success/.test(s) ? "✓" : /run|exec|leas/.test(s) ? "▸" : "∘";
