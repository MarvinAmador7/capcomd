// Agent titles (capability agents.title): every agent has a short title that names its crew tab in the desktop app,
// its row in the menu bar and wherever else an agent is named. The agent names itself (`capcomd title "<words>"` in
// its VM, Rex-style), its parent may name it at spawn or later, the user's driving harness may name it, and the user
// may rename it in the apps; when nobody did, the daemon derives one from the task. Pure functions: the scope actor
// stores the state (agents_v2.title, scope_meta run_title) and checks renames with these, the API and clients show
// `shownTitle`.

// How a title is cleaned and refused, and the rate limit, live in title-rules.mjs: the same file is the shim an agent
// that may not spawn names its tab with, so it says what the daemon will.
import { cleanTitle, INVISIBLE, normalizeTitle, RENAME_WINDOW_MS, RENAMES_MAX, renameRefusal, TITLE_MAX_CHARS, TITLE_WORDS_MAX, titleLength } from "./title-rules.mjs";
export { cleanTitle, normalizeTitle, RENAME_WINDOW_MS, RENAMES_MAX, renameRefusal, TITLE_MAX_CHARS, TITLE_WORDS_MAX };

/** Who set a title: the agent itself, its parent, the user's driving harness (MCP, CLI), the user in the apps. */
export type TitleBy = "self" | "parent" | "driver" | "user";
/** Where Agent.title comes from: one of those, or the daemon's own from the task. */
export type TitleSource = TitleBy | "derived";
export const AGENT_TITLE_SOURCES = ["user", "self", "parent", "driver", "derived"] as const;

/** What an agent's title row holds (agents_v2.title, JSON). The user's title sticks until the user clears it; the
 *  latest of self, parent and driver is kept under it, so clearing reveals it. */
export interface TitleState {
  user?: { title: string; at: number } | null;
  agent?: { title: string; by: Exclude<TitleBy, "user">; setBy: string; at: number } | null;
  /** Agent and parent renames so far (RENAMES_MAX). */
  count?: number;
  /** When each setter last renamed it (RENAME_WINDOW_MS). */
  last?: Record<string, number>;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const len = titleLength;
const take = (s: string, n: number) => { let out = ""; let i = 0; for (const g of graphemes.segment(s)) { if (i++ >= n) break; out += g.segment; } return out; };

// The derived title: the task's first meaningful words. Markers ([listen], [agent:…], headings, list bullets) and
// filler go; a short "Goal:" or "Task:" label before the text goes; the text stops at its first clause boundary.
const LEADING_MARKER = /^(#{1,6}\s+|[-*+•]\s+|>\s*|[0-9]{1,3}[.)]\s+|\[[^\]\n]*\]\s*)/;
const INLINE_MARKER = /\[[a-z][a-z0-9_-]*(:[^\]\n]*)?\]/gi;
const CLAUSE = /(\.\s|;\s|:\s|\s[—–-]\s|,\s|\s\(|\?|!|\.$)/;
const POLITE = new Set(["please", "pls", "kindly", "can", "could", "would", "will", "you"]);
const ARTICLES = new Set(["the", "a", "an"]);
const DANGLING = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "with", "in", "on", "at", "by", "from", "into", "so", "that", "is", "are", "be"]);
const EDGE = /^[\s"'`*_()[\]{}<>.,;:!?“”‘’«»]+|[\s"'`*_()[\]{}<>.,;:!?“”‘’«»]+$/g;

/**
 * The daemon's title for an agent nobody named: from the first line of its task with words in it, up to its first
 * clause boundary, lowercase, without markers, articles or a leading "please", at most TITLE_WORDS_MAX words and
 * TITLE_MAX_CHARS characters (fewer words, else one word cut). Null when the task has no words.
 */
export function derivedTitle(task: string | null | undefined): string | null {
  if (!task) return null;
  for (const raw of task.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/)) {
    let line = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
    for (let prev = ""; prev !== line;) { prev = line; line = line.replace(LEADING_MARKER, "").trim(); }
    line = line.replace(INLINE_MARKER, " ").replaceAll("`", "").replaceAll("**", "").replace(/\s+/g, " ").trim();
    // "Goal: add multiply", "Task 2: fix the sum": the label isn't the work.
    const label = /^([\p{L}\p{N}]+(?: [\p{L}\p{N}]+)?):\s+(\S.*)$/u.exec(line);
    if (label) line = label[2]!;
    line = line.replace(/\([^()\n]*\)/g, "").replace(/\s+/g, " ").trim();
    const clause = CLAUSE.exec(line);
    if (clause && clause.index > 0) line = line.slice(0, clause.index);
    let words = line.toLowerCase().split(" ").map((w) => w.replace(EDGE, "")).filter(Boolean);
    while (words.length && POLITE.has(words[0]!)) words.shift();
    words = words.filter((w) => !ARTICLES.has(w)).slice(0, TITLE_WORDS_MAX);
    const trim = () => { while (words.length > 1 && DANGLING.has(words.at(-1)!)) words.pop(); };
    trim();
    while (words.length > 1 && len(words.join(" ")) > TITLE_MAX_CHARS) { words.pop(); trim(); }
    if (!words.length || (words.length === 1 && DANGLING.has(words[0]!))) continue;
    const t = words.join(" ");
    return len(t) > TITLE_MAX_CHARS ? take(t, TITLE_MAX_CHARS) : t;
  }
  return null;
}

/** The title shown for an agent (harness.v1 Agent.title, titleSource): the user's, else the latest agent-set one,
 *  else the derived one; null only when nobody set one and the task has no words. */
export function shownTitle(s: TitleState | null | undefined, task: string | null | undefined): { title: string | null; titleSource: TitleSource | null } {
  if (s?.user) return { title: s.user.title, titleSource: "user" };
  if (s?.agent) return { title: s.agent.title, titleSource: s.agent.by };
  const d = derivedTitle(task);
  return d ? { title: d, titleSource: "derived" } : { title: null, titleSource: null };
}

/** What setting or clearing a title does to the state, and what the call answers. */
export type TitleChange = {
  next: TitleState;
  /** Something was recorded (false: the same title from the same source again, or nothing to clear). */
  changed: boolean;
  /** The title this call set is the one shown now (false: a user title holds the tab). */
  shown: boolean;
  /** What Agent.title / titleSource read after it. */
  title: string | null;
  titleSource: TitleSource | null;
};

/**
 * Apply a set (title) or the user's clear (null, by "user") to a title state. Agent and parent sets count toward the
 * rate limit (checked first with renameRefusal); `counted: false` for a title given at spawn.
 */
export function applyTitle(s: TitleState | null | undefined, task: string | null | undefined, o: { title: string | null; by: TitleBy; setBy: string; now: number; counted?: boolean }): TitleChange {
  const cur: TitleState = { ...(s ?? {}) };
  let next: TitleState = cur, changed = false;
  if (o.title === null) {
    if (o.by !== "user") throw new Error("only the user clears a title");
    if (cur.user) { next = { ...cur, user: null }; changed = true; }
  } else if (o.by === "user") {
    if (cur.user?.title !== o.title) { next = { ...cur, user: { title: o.title, at: o.now } }; changed = true; }
  } else if (!(cur.agent?.title === o.title && cur.agent.by === o.by && cur.agent.setBy === o.setBy)) {
    const counts = (o.by === "self" || o.by === "parent") && o.counted !== false;
    next = { ...cur, agent: { title: o.title, by: o.by, setBy: o.setBy, at: o.now },
      ...(counts ? { count: (cur.count ?? 0) + 1, last: { ...(cur.last ?? {}), [o.setBy]: o.now } } : {}) };
    changed = true;
  }
  const shown = shownTitle(next, task);
  return { next, changed, shown: o.title === null || (shown.title === o.title && shown.titleSource === o.by), ...shown };
}
