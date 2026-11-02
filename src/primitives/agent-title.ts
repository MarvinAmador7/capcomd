// Agent titles (capability agents.title): every agent has a short title that names its crew tab in the desktop app,
// its row in the menu bar and wherever else an agent is named. The agent names itself (`capcomd title "<words>"` in
// its VM, Rex-style), its parent may name it at spawn or later, the user's driving harness may name it, and the user
// may rename it in the apps; when nobody did, the daemon derives one from the task. Pure functions: the scope actor
// stores the state (agents_v2.title, scope_meta run_title) and checks renames with these, the API and clients show
// `shownTitle`.

/** A title is 1 to TITLE_WORDS_MAX plain lowercase words, at most TITLE_MAX_CHARS characters, one line. */
export const TITLE_WORDS_MAX = 4;
export const TITLE_MAX_CHARS = 32;
/** Agent and parent renames: at most one per setter per agent every RENAME_WINDOW_MS, RENAMES_MAX per agent (or run). */
export const RENAME_WINDOW_MS = 30_000;
export const RENAMES_MAX = 20;

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
const len = (s: string) => { let n = 0; for (const _ of graphemes.segment(s)) n++; return n; };
const take = (s: string, n: number) => { let out = ""; let i = 0; for (const g of graphemes.segment(s)) { if (i++ >= n) break; out += g.segment; } return out; };
// Control and format characters (bidi overrides, zero-width spaces, BOMs): a title is one plain line. A zero-width
// joiner stays only inside an emoji sequence (👩‍💻), where it is part of one character.
const INVISIBLE = /(?!\u200D)[\p{Cc}\p{Cf}\u2028\u2029]|(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/** Trimmed, one line, whitespace collapsed, lowercase, without control or format characters. */
export function cleanTitle(raw: string): string {
  return raw.replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A title as given (by an agent, a parent, a driver or the user): cleaned, then refused when it has no words, more
 * than TITLE_WORDS_MAX or more than TITLE_MAX_CHARS characters. Never cut: the agent should pick shorter words.
 */
export function normalizeTitle(raw: unknown): { ok: true; title: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "a title is text: 1 to 4 lowercase words, e.g. \"login redirect\"" };
  const t = cleanTitle(raw);
  if (!t) return { ok: false, error: "a title needs at least one word: name what you're working on in 1 to 4 lowercase words, e.g. \"login redirect\"" };
  const words = t.split(" ").length;
  if (words > TITLE_WORDS_MAX) return { ok: false, error: `a title is 1 to ${TITLE_WORDS_MAX} words, not ${words}: say what you're working on in fewer words, e.g. "login redirect"` };
  const n = len(t);
  if (n > TITLE_MAX_CHARS) return { ok: false, error: `a title is at most ${TITLE_MAX_CHARS} characters, not ${n}: pick shorter words` };
  return { ok: true, title: t };
}

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

const ago = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/**
 * Whether `setBy` may rename now (agent and parent renames; the user's and the driver's aren't limited): null, or the
 * refusal as one sentence. `what` names what is renamed as the caller sees it ("your tab", "agt-x", "the run"). A
 * title given at spawn isn't checked.
 */
export function renameRefusal(s: Pick<TitleState, "count" | "last"> | null | undefined, setBy: string, what: string, now: number): string | null {
  if ((s?.count ?? 0) >= RENAMES_MAX) return `${what} has been renamed ${RENAMES_MAX} times, the most capcomd allows: keep the title it has`;
  const last = s?.last?.[setBy];
  if (last !== undefined && now - last < RENAME_WINDOW_MS) {
    return `you renamed ${what} ${ago(now - last)} ago: rename at most once every ${RENAME_WINDOW_MS / 1000} s (try again in ${ago(RENAME_WINDOW_MS - (now - last))}), and only when your focus really changes`;
  }
  return null;
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
