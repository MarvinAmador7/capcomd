#!/usr/bin/env node
// Agent title rules (capability agents.title), in one dependency-free file with two uses:
//  - the daemon imports them (src/primitives/agent-title.ts): how a title is cleaned, when it is refused, the rate limit;
//  - it is the `capcomd` an agent that may not spawn finds on its PATH in its VM (src/agents/runner.ts). There it only
//    knows `capcomd title <words>`: it checks the title with these same rules and its own rename times, prints
//    "ok: <title>" or the refusal, and exits. It talks to nobody: the daemon reads the call from the agent's own tool
//    calls (packages/agent-thread/src/naming.ts) and records it as the agent's.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A title is 1 to TITLE_WORDS_MAX plain lowercase words, at most TITLE_MAX_CHARS characters, one line. */
export const TITLE_WORDS_MAX = 4;
export const TITLE_MAX_CHARS = 32;
/** Agent and parent renames: at most one per setter per agent every RENAME_WINDOW_MS, RENAMES_MAX per agent (or run). */
export const RENAME_WINDOW_MS = 30_000;
export const RENAMES_MAX = 20;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Characters as people see them (an emoji is one). */
export const titleLength = (s) => { let n = 0; for (const _ of graphemes.segment(s)) n++; return n; };
// Control and format characters (bidi overrides, zero-width spaces, BOMs): a title is one plain line. A zero-width
// joiner stays only inside an emoji sequence (👩\u200D💻), where it is part of one character.
export const INVISIBLE = /(?!\u200D)[\p{Cc}\p{Cf}\u2028\u2029]|(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/** Trimmed, one line, whitespace collapsed, lowercase, without control or format characters. */
export function cleanTitle(raw) {
  return raw.replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A title as given (by an agent, a parent, a driver or the user): cleaned, then refused when it has no words, more
 * than TITLE_WORDS_MAX or more than TITLE_MAX_CHARS characters. Never cut: the agent should pick shorter words.
 * @returns {{ ok: true, title: string } | { ok: false, error: string }}
 */
export function normalizeTitle(raw) {
  if (typeof raw !== "string") return { ok: false, error: "a title is text: 1 to 4 lowercase words, e.g. \"login redirect\"" };
  const t = cleanTitle(raw);
  if (!t) return { ok: false, error: "a title needs at least one word: name what you're working on in 1 to 4 lowercase words, e.g. \"login redirect\"" };
  const words = t.split(" ").length;
  if (words > TITLE_WORDS_MAX) return { ok: false, error: `a title is 1 to ${TITLE_WORDS_MAX} words, not ${words}: say what you're working on in fewer words, e.g. "login redirect"` };
  const n = titleLength(t);
  if (n > TITLE_MAX_CHARS) return { ok: false, error: `a title is at most ${TITLE_MAX_CHARS} characters, not ${n}: pick shorter words` };
  return { ok: true, title: t };
}

const ago = (ms) => `${Math.max(1, Math.round(ms / 1000))} s`;

/**
 * Whether `setBy` may rename now (agent and parent renames; the user's and the driver's aren't limited): null, or the
 * refusal as one sentence. `what` names what is renamed as the caller sees it ("your tab", "agt-x", "the run"). A
 * title given at spawn isn't checked.
 * @param {{ count?: number, last?: Record<string, number> } | null | undefined} s
 * @returns {string | null}
 */
export function renameRefusal(s, setBy, what, now) {
  if ((s?.count ?? 0) >= RENAMES_MAX) return `${what} has been renamed ${RENAMES_MAX} times, the most capcomd allows: keep the title it has`;
  const last = s?.last?.[setBy];
  if (last !== undefined && now - last < RENAME_WINDOW_MS) {
    return `you renamed ${what} ${ago(now - last)} ago: rename at most once every ${RENAME_WINDOW_MS / 1000} s (try again in ${ago(RENAME_WINDOW_MS - (now - last))}), and only when your focus really changes`;
  }
  return null;
}

export const SHIM_USAGE = 'This capcomd only names your tab: capcomd title "<2-4 lowercase words>" (e.g. capcomd title "login redirect")';

/**
 * The shim: `title <words…>` → [exit code, what it prints]. `state` is its own record of renames (the daemon keeps the
 * real one; this keeps the agent from hearing "ok" for a rename the daemon will refuse).
 */
export function shimMain(argv, state, now) {
  if (argv[0] !== "title" || argv.length < 2) return { code: 2, out: SHIM_USAGE, state };
  if (/^agt-/.test(argv[1]) || argv.includes("--run")) return { code: 2, out: `${SHIM_USAGE}. Only you: naming other agents or the run is for agents that spawn them`, state };
  const n = normalizeTitle(argv.slice(1).join(" "));
  if (!n.ok) return { code: 1, out: n.error, state };
  if (state?.title === n.title) return { code: 0, out: `ok: ${n.title}`, state };
  const no = renameRefusal(state, "self", "your tab", now);
  if (no) return { code: 1, out: no, state };
  return { code: 0, out: `ok: ${n.title}`, state: { title: n.title, count: (state?.count ?? 0) + 1, last: { self: now } } };
}

// Run as the shim (not imported). Its record sits next to it, in the agent's own folder.
const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return ""; } })();
const isMain = (() => { try { return self === realpathSync(process.argv[1] ?? ""); } catch { return false; } })();
if (isMain) {
  const file = join(dirname(self), "title-state.json");
  let state = null;
  try { if (existsSync(file)) state = JSON.parse(readFileSync(file, "utf8")); } catch { /* unreadable: start over */ }
  const r = shimMain(process.argv.slice(2), state, Date.now());
  if (r.state !== state) { try { writeFileSync(file, JSON.stringify(r.state)); } catch { /* read-only: the daemon still limits */ } }
  console.log(r.out);
  process.exit(r.code);
}
