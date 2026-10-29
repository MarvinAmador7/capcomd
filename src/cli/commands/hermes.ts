// capcomd in Hermes (Nous Research's hermes-agent): `capcomd setup agent` registers `capcomd mcp` as an MCP server in
// Hermes's config.yaml and installs the capcomd skills in its skills directory; `capcomd setup check` reports it.
// What Hermes reads (checked against NousResearch/hermes-agent@e5ea5fd, 2026-10-27):
//   - home: $HERMES_HOME, else ~/.hermes, or ~/.hermes/profiles/<name> when ~/.hermes/active_profile names one;
//   - MCP servers: `mcp_servers.<name>` in <home>/config.yaml ({command, args, env, cwd, trust, enabled, timeout, …}); a
//     stdio server gets only PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR, XDG_* and its own `env`, and starts
//     in `cwd` (else the session's or Hermes's directory); `timeout` bounds a tool call (default 300 s);
//   - elicitation (form mode) goes to Hermes's approval prompt (terminal, or buttons in Telegram, Slack…): only Allow
//     Once / Deny, never answered by /yolo or approvals.mode off, 300 s by default; accept carries empty content;
//   - `trust: untrusted`: Hermes asks the user before every tool without readOnlyHint, unless `mcp:<server>/<tool>`
//     is in `command_allowlist` (a list of strings; "Always" answers land there too);
//   - `approvals.deny`: globs of terminal commands Hermes never runs, whatever its approval mode;
//   - skills: any SKILL.md under <home>/skills (Agent Skills frontmatter: name, description).
// The config is edited in place: only the entries capcomd owns change, the rest of the file (comments, order,
// quoting) stays as it was. Nothing here runs Hermes.
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import { ORCHESTRATION_SKILL, SETUP_SKILL } from "../../utils/assets";
import { COMPILED } from "../../utils/home";
import { selfArgv } from "../../utils/self";

type Env = Record<string, string | undefined>;

/** The server's name in Hermes: its tools show up as mcp__capcomd__<tool> (tools/mcp_tool_schema.py). */
export const HERMES_SERVER = "capcomd";
/** The skills Hermes gets (Claude Code and Codex get the same ones with the plugin). */
export const HERMES_SKILLS: Record<string, string> = { "capcomd-orchestration": ORCHESTRATION_SKILL, "capcomd-setup": SETUP_SKILL };
/** Skills go in their own category directory: <home>/skills/capcomd/<skill>/SKILL.md. */
export const HERMES_SKILL_CATEGORY = "capcomd";
/**
 * capcomd's write tools that Hermes may call without asking (they're in the project's limits anyway). The server is
 * `trust: untrusted`, so Hermes asks the user before the rest: capcomd_merge, capcomd_cancel and capcomd_approve,
 * the tools capcomd marks destructiveHint (Hermes doesn't read that hint, only readOnlyHint). Reads never ask.
 */
export const HERMES_ALLOWED_TOOLS = ["capcomd_run_new", "capcomd_spawn", "capcomd_send", "capcomd_resume", "capcomd_grant", "capcomd_verify", "capcomd_task", "capcomd_kv"];
export const hermesAllowlist = (server = HERMES_SERVER) => HERMES_ALLOWED_TOOLS.map((t) => `mcp:${server}/${t}`);
/**
 * Hermes's timeout for a capcomd tool call (s), set when the entry has none: longer than capcomd_approve's prompt
 * (300 s, like Hermes's own elicitation timeout) plus the merge it starts, so the call outlives the question.
 */
export const HERMES_TOOL_TIMEOUT = 360;
/** The name of a separate entry for one project (`setup agent --hermes-entry-per-project`): capcomd-<project>. */
export const hermesProjectServer = (project: string) => `${HERMES_SERVER}-${project.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project"}`;
/** Hermes's terminal never runs `capcomd approve`: approving stays the user's (or goes through the asked-for tool). */
export const HERMES_DENY = ["capcomd approve*"];

export interface HermesInfo {
  /** Hermes is installed: its home exists or its CLI is on PATH. */
  found: boolean;
  /** Its home holds a set-up Hermes (config.yaml, .env, SOUL.md or the install). */
  homeExists: boolean;
  home: string;
  config: string;
  profile: string | null;
  bin: string | null;
}

const tildeOf = (p: string) => { const h = resolve(homedir()); return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p; };
export const tilde = tildeOf;

/** Hermes's home, the way Hermes finds it: HERMES_HOME, else the sticky profile, else ~/.hermes. */
export function hermesHome(env: Env = process.env, userHome = homedir()): { home: string; profile: string | null } {
  const raw = env.HERMES_HOME?.trim();
  if (raw) return { home: resolve(raw.replace(/^~(?=$|\/)/, userHome)), profile: null };
  const base = join(userHome, ".hermes");
  let active = "";
  try { active = readFileSync(join(base, "active_profile"), "utf8").trim(); } catch {}
  if (active && active !== "default" && /^[\w.-]+$/.test(active) && existsSync(join(base, "profiles", active))) return { home: join(base, "profiles", active), profile: active };
  return { home: base, profile: null };
}

/** Is Hermes here? Looks at files only (its home, its CLI on PATH); never runs it. */
export function detectHermes(env: Env = process.env, userHome = homedir()): HermesInfo {
  const { home, profile } = hermesHome(env, userHome);
  const cli = env.CAPCOMD_HERMES_CLI ?? "hermes";
  let bin: string | null = null;
  if (cli.includes("/")) bin = existsSync(cli) ? cli : null;
  else {
    bin = Bun.which(cli, { PATH: env.PATH ?? "" });
    // Hermes's installer puts its CLI in ~/.local/bin, which a non-login shell may not have on PATH.
    const local = join(userHome, ".local", "bin", cli);
    if (!bin && existsSync(local)) bin = local;
  }
  const homeExists = ["config.yaml", ".env", "SOUL.md", "hermes-agent", "state.db"].some((f) => existsSync(join(home, f)));
  return { found: homeExists || !!bin, homeExists, home, config: join(home, "config.yaml"), profile, bin };
}

/** How Hermes starts `capcomd mcp`: absolute paths, since Hermes's PATH (a service's, say) may not find capcomd. */
export function capcomdMcpCommand(env: Env = process.env): { command: string; args: string[] } {
  const argv = selfArgv("mcp");
  if (COMPILED) {
    // The binary as installed (~/.capcomd/bin/capcomd, a Homebrew link) survives upgrades; its target may not.
    const onPath = Bun.which("capcomd", { PATH: env.PATH ?? "" });
    try { if (onPath && realpathSync(onPath) === realpathSync(process.execPath)) return { command: onPath, args: ["mcp"] }; } catch {}
  }
  return { command: argv[0]!, args: argv.slice(1) };
}

/**
 * The capcomd entry in Hermes's mcp_servers. The shared entry has no `cwd` (one entry for every project: tools take
 * `project`); a per-project entry pins its checkout. `timeout` is written only when the entry has none.
 */
export interface HermesEntry { command: string; args: string[]; cwd?: string; env?: Record<string, string>; trust: "untrusted"; timeout?: number }

const MANAGED = ["command", "args", "cwd", "env", "trust"];

/**
 * The entry that should be there: ours over what's there, keeping the keys the user added (timeout, tools, enabled,
 * env…). A `cwd` comes only from `want`: the shared entry drops one an older setup pinned (that folder becomes a
 * project in capcomd's list instead).
 */
export function mergedEntry(existing: unknown, want: HermesEntry): Record<string, unknown> {
  const cur = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  const curEnv = cur.env && typeof cur.env === "object" && !Array.isArray(cur.env) ? (cur.env as Record<string, unknown>) : {};
  const env = { ...curEnv, ...(want.env ?? {}) };
  const out: Record<string, unknown> = { command: want.command, args: want.args };
  if (want.cwd) out.cwd = want.cwd;
  if (Object.keys(env).length) out.env = env;
  out.trust = want.trust;
  if (want.timeout !== undefined && cur.timeout === undefined) out.timeout = want.timeout;
  for (const [k, v] of Object.entries(cur)) if (!MANAGED.includes(k)) out[k] = v;
  return out;
}

const q = (s: string) => JSON.stringify(s);
const pad = (n: number) => " ".repeat(n);
/** YAML for a value, as lines indented by `col`. */
function blockLines(value: unknown, col: number): string[] {
  return stringify(value, { lineWidth: 0 }).replace(/\n$/, "").split("\n").map((l) => pad(col) + l);
}
/** Our entry, as `capcomd:` and its keys (the first line at `col`, children `step` deeper). */
function entryLines(e: Record<string, unknown>, col: number, step: number, server = HERMES_SERVER): string[] {
  const c = pad(col + step);
  const lines = [`${pad(col)}${server}:  # capcomd setup agent keeps this entry; re-run it to update`];
  lines.push(`${c}command: ${q(String(e.command))}`, `${c}args: [${(e.args as string[]).map(q).join(", ")}]`);
  if (typeof e.cwd === "string") lines.push(`${c}cwd: ${q(e.cwd)}`);
  if (e.env && typeof e.env === "object") {
    lines.push(`${c}env:`);
    for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) lines.push(`${c}${pad(step)}${k}: ${typeof v === "string" ? q(v) : stringify(v).trim()}`);
  }
  lines.push(`${c}trust: ${e.trust}`);
  for (const [k, v] of Object.entries(e)) if (!MANAGED.includes(k)) lines.push(...blockLines({ [k]: v }, col + step));
  return lines;
}

const deepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const lineStart = (s: string, pos: number) => s.lastIndexOf("\n", pos - 1) + 1;
const columnOf = (s: string, pos: number) => pos - lineStart(s, pos);
const leading = (s: string, pos: number) => { const ls = lineStart(s, pos); let i = ls; while (s[i] === " ") i++; return i - ls; };
const keyIs = (p: any, k: string) => isScalar(p?.key) && String(p.key.value) === k;
/** Text inserted at `pos`, starting on a line of its own. */
const insertLines = (s: string, pos: number, lines: string[]) => s.slice(0, pos) + (pos > 0 && s[pos - 1] !== "\n" ? "\n" : "") + lines.join("\n") + "\n" + s.slice(pos);
/** A root-level block appended at the end, after a blank line. */
const appendRoot = (s: string, lines: string[]) => (s.trim() ? s.replace(/\n*$/, "\n\n") : "") + lines.join("\n") + "\n";
/** The value of `pair` replaced by `lines` (a block under its key). */
const replaceValue = (s: string, pair: any, lines: string[]) => {
  const end = pair.value?.range ? pair.value.range[1] : pair.key.range[2];
  return s.slice(0, pair.key.range[1]) + ":\n" + lines.join("\n") + s.slice(end);
};

type Parsed = { ok: true; root: any; doc: ReturnType<typeof parseDocument> } | { ok: false; error: string };
function parse(src: string): Parsed {
  // YAML 1.1, like Hermes (`off`/`no` are booleans there).
  const doc = parseDocument(src, { version: "1.1" });
  if (doc.errors.length) return { ok: false, error: doc.errors[0]!.message.split("\n")[0]! };
  const root = doc.contents;
  if (root != null && !isMap(root) && !(isScalar(root) && root.value == null)) return { ok: false, error: "its top level isn't a mapping" };
  return { ok: true, root: isMap(root) ? root : null, doc };
}

/** mcp_servers.<server> set to `want` (merged with what's there). */
function setServer(src: string, want: HermesEntry, server = HERMES_SERVER): { text: string; change?: string } | { error: string } {
  const p = parse(src);
  if (!p.ok) return { error: p.error };
  const servers = p.root?.items.find((x: any) => keyIs(x, "mcp_servers"));
  if (!servers) {
    const e = mergedEntry(undefined, want);
    return { text: appendRoot(src, ["# capcomd (https://github.com/MarvinAmador7/capcomd): its MCP tools for Hermes", "mcp_servers:", ...entryLines(e, 2, 2, server)]), change: `added mcp_servers.${server}` };
  }
  const v = servers.value;
  const keyCol = columnOf(src, servers.key.range[0]);
  if (isMap(v) && !v.flow && v.items.length) {
    const col = columnOf(src, (v.items[0] as any).key.range[0]);
    const step = Math.max(col - keyCol, 2);
    const mine = v.items.find((x: any) => keyIs(x, server)) as any;
    if (!mine) return { text: insertLines(src, v.range![2], entryLines(mergedEntry(undefined, want), col, step, server)), change: `added mcp_servers.${server}` };
    const cur = mine.value?.toJSON?.() ?? null;
    const next = mergedEntry(cur, want);
    if (deepEqual(cur, next)) return { text: src };
    const start = mine.key.range[0];
    const end = Math.max(mine.key.range[2], mine.value?.range?.[2] ?? 0);
    const ending = src.slice(start, end).endsWith("\n") ? "\n" : "";
    const changed = Object.keys({ ...(cur ?? {}), ...next }).filter((k) => !deepEqual(cur?.[k], next[k]));
    return { text: src.slice(0, start) + entryLines(next, col, step, server).join("\n").slice(col) + ending + src.slice(end), change: `updated mcp_servers.${server} (${changed.join(", ")})` };
  }
  // Empty, null or a flow mapping ({…}): rewrite that value as a block, other servers included.
  const js = v == null || (isScalar(v) && v.value == null) ? {} : isMap(v) ? (v.toJSON() as Record<string, unknown>) : null;
  if (!js || typeof js !== "object" || Array.isArray(js)) return { error: "mcp_servers isn't a mapping" };
  const col = keyCol + 2;
  const lines: string[] = [];
  for (const [k, val] of Object.entries(js)) if (k !== server) lines.push(...blockLines({ [k]: val }, col));
  lines.push(...entryLines(mergedEntry(js[server], want), col, 2, server));
  return { text: replaceValue(src, servers, lines), change: server in js ? `updated mcp_servers.${server}` : `added mcp_servers.${server}` };
}

/** `items` present in the list at `path` (one or two keys deep), adding only what's missing. */
function ensureList(src: string, path: [string] | [string, string], items: string[]): { text: string; added: string[] } | { error: string } {
  const p = parse(src);
  if (!p.ok) return { error: p.error };
  const name = path.join(".");
  const seqLines = (list: string[], col: number) => list.map((i) => `${pad(col)}- ${q(i)}`);
  const top = p.root?.items.find((x: any) => keyIs(x, path[0]));
  let holder: any = top;
  let holderCol = 0;
  if (path.length === 2) {
    if (!top) return { text: appendRoot(src, [`${path[0]}:`, `  ${path[1]}:`, ...seqLines(items, 4)]), added: items };
    const m = top.value;
    holderCol = columnOf(src, top.key.range[0]);
    if (isMap(m) && !m.flow && m.items.length) {
      holder = m.items.find((x: any) => keyIs(x, path[1]));
      const col = columnOf(src, (m.items[0] as any).key.range[0]);
      if (!holder) return { text: insertLines(src, m.range![2], [`${pad(col)}${path[1]}:`, ...seqLines(items, col + 2)]), added: items };
      holderCol = col;
    } else {
      const js = m == null || (isScalar(m) && m.value == null) ? {} : isMap(m) ? (m.toJSON() as Record<string, unknown>) : null;
      if (!js) return { error: `${path[0]} isn't a mapping` };
      const cur = Array.isArray(js[path[1]]) ? (js[path[1]] as unknown[]) : js[path[1]] == null ? [] : null;
      if (!cur) return { error: `${name} isn't a list` };
      const add = items.filter((i) => !cur.includes(i));
      if (!add.length) return { text: src, added: [] };
      const others = Object.entries(js).filter(([k]) => k !== path[1]).flatMap(([k, val]) => blockLines({ [k]: val }, holderCol + 2));
      return { text: replaceValue(src, top, [...others, `${pad(holderCol + 2)}${path[1]}:`, ...seqLines([...(cur as string[]), ...add], holderCol + 4)]), added: add };
    }
  } else if (!top) {
    return { text: appendRoot(src, [`${path[0]}:`, ...seqLines(items, 2)]), added: items };
  } else holderCol = columnOf(src, top.key.range[0]);
  const v = holder.value;
  const cur = isSeq(v) ? (v.toJSON() as unknown[]) : v == null || (isScalar(v) && v.value == null) ? [] : null;
  if (!cur) return { error: `${name} isn't a list` };
  const add = items.filter((i) => !cur.includes(i));
  if (!add.length) return { text: src, added: [] };
  if (isSeq(v) && !v.flow && v.items.length) return { text: insertLines(src, v.range![2], seqLines(add, leading(src, (v.items[0] as any).range[0]))), added: add };
  return { text: replaceValue(src, holder, seqLines([...(cur as string[]), ...add], holderCol + 2)), added: add };
}

export type EditResult = { ok: true; text: string; changes: string[] } | { ok: false; error: string };

/**
 * Hermes's config.yaml with capcomd in it: mcp_servers.capcomd (added, or updated keeping the user's own keys), the
 * allowlist for capcomd's non-destructive write tools, and `capcomd approve` denied to Hermes's terminal. Only those
 * spots change; a file it can't read safely is left alone (an error says why).
 */
export function editHermesConfig(src: string, want: HermesEntry, o: { allow?: string[]; deny?: string[]; server?: string } = {}): EditResult {
  const server = o.server ?? HERMES_SERVER;
  const changes: string[] = [];
  let text = src;
  const s = setServer(text, want, server);
  if ("error" in s) return { ok: false, error: s.error };
  text = s.text;
  if (s.change) changes.push(s.change);
  const allow = o.allow ?? hermesAllowlist(server);
  if (allow.length) {
    const a = ensureList(text, ["command_allowlist"], allow);
    if ("error" in a) return { ok: false, error: a.error };
    text = a.text;
    if (a.added.length) changes.push(`allowed ${a.added.length} capcomd tool${a.added.length === 1 ? "" : "s"} in command_allowlist`);
  }
  const deny = o.deny ?? HERMES_DENY;
  if (deny.length) {
    const d = ensureList(text, ["approvals", "deny"], deny);
    if ("error" in d) return { ok: false, error: d.error };
    text = d.text;
    if (d.added.length) changes.push(`denied ${d.added.map((x) => `"${x}"`).join(", ")} in approvals.deny`);
  }
  // Never write a file Hermes would read differently than intended.
  const check = parse(text);
  if (!check.ok) return { ok: false, error: `the edit would break the file (${check.error})` };
  const js: any = check.doc.toJSON() ?? {};
  const orig = parse(src);
  const before: any = orig.ok ? orig.doc.toJSON() ?? {} : {};
  const wantEntry = mergedEntry(before?.mcp_servers?.[server], want);
  const sameOthers = Object.keys(before).every((k) => ["mcp_servers", "command_allowlist", "approvals"].includes(k) || deepEqual(before[k], js[k]));
  const serversKept = Object.keys(before?.mcp_servers ?? {}).every((k) => k === server || deepEqual(before.mcp_servers[k], js.mcp_servers?.[k]));
  if (!deepEqual(js.mcp_servers?.[server], wantEntry) || !sameOthers || !serversKept
    || !allow.every((a) => js.command_allowlist?.includes(a)) || !deny.every((d) => js.approvals?.deny?.includes(d))) {
    return { ok: false, error: "the edit didn't come out as intended (an unusual layout); nothing was changed" };
  }
  return { ok: true, text, changes };
}

/** The config as Hermes reads it (parsed), or why not. */
export function readHermesConfig(path: string): { ok: true; js: any; src: string } | { ok: false; error: string } {
  const src = existsSync(path) ? readFileSync(path, "utf8") : "";
  const p = parse(src);
  return p.ok ? { ok: true, js: p.doc.toJSON() ?? {}, src } : { ok: false, error: p.error };
}

/** Write the file in one step (a temp file renamed over it), keeping its mode; the old one is kept as <file>.capcomd.bak. */
export function writeHermesConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  if (existsSync(path)) {
    mode = statSync(path).mode & 0o777;
    writeFileSync(`${path}.capcomd.bak`, readFileSync(path), { mode });
  }
  const tmp = `${path}.capcomd.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The capcomd skills in <home>/skills/capcomd/. A copy capcomd wrote earlier is updated; one edited since (by the
 * user, or by Hermes improving it) is kept, and the result says so.
 */
export function installHermesSkills(home: string): { added: string[]; updated: string[]; current: string[]; kept: string[]; dir: string } {
  const dir = join(home, "skills", HERMES_SKILL_CATEGORY);
  const manifestPath = join(dir, ".capcomd.json");
  let manifest: { skills?: Record<string, string> } = {};
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {}
  const written: Record<string, string> = { ...(manifest.skills ?? {}) };
  const out = { added: [] as string[], updated: [] as string[], current: [] as string[], kept: [] as string[], dir };
  for (const [name, body] of Object.entries(HERMES_SKILLS)) {
    const f = join(dir, name, "SKILL.md");
    if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); written[name] = sha(body); out.added.push(name); continue; }
    const cur = readFileSync(f, "utf8");
    if (cur === body) { written[name] = sha(body); out.current.push(name); continue; }
    if (written[name] === sha(cur)) { writeFileSync(f, body); written[name] = sha(body); out.updated.push(name); continue; }
    out.kept.push(name);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ note: "capcomd setup agent: what it installed here, to update only unedited copies", skills: written }, null, 2) + "\n");
  return out;
}

/** What the capcomd entry in Hermes looks like now, for `setup check`. */
export function hermesStatus(env: Env = process.env, userHome = homedir()): { ok: boolean; found: boolean; detail: string; hint?: string } {
  const h = detectHermes(env, userHome);
  if (!h.found) return { ok: true, found: false, detail: "Hermes not found (if you use it, `capcomd setup agent` adds capcomd to it)" };
  const where = `${tildeOf(h.home)}${h.profile ? ` (profile ${h.profile})` : ""}`;
  const fix = `Run \`capcomd setup agent\` (it edits ${tildeOf(h.config)}; \`--no-hermes\` skips Hermes).`;
  if (!h.homeExists) return { ok: false, found: true, detail: `Hermes is installed (${h.bin}) but not set up (${where})`, hint: "Run `hermes setup` once, then `capcomd setup agent`." };
  const c = readHermesConfig(h.config);
  if (!c.ok) return { ok: false, found: true, detail: `can't read ${tildeOf(h.config)}: ${c.error}`, hint: "Fix the file (Hermes can't read it either), then run `capcomd setup agent`." };
  // The shared entry, else a per-project one (`--hermes-entry-per-project`).
  const servers = c.js?.mcp_servers && typeof c.js.mcp_servers === "object" ? c.js.mcp_servers : {};
  const e = servers[HERMES_SERVER] ?? Object.entries(servers).find(([k]) => k.startsWith(`${HERMES_SERVER}-`))?.[1];
  if (!e) return { ok: false, found: true, detail: `Hermes in ${where}, without capcomd`, hint: fix };
  if (e.enabled === false) return { ok: false, found: true, detail: `capcomd is disabled in ${tildeOf(h.config)} (enabled: false)`, hint: "Remove `enabled: false` from mcp_servers.capcomd, then /reload-mcp in Hermes." };
  if (typeof e.command !== "string" || (e.command.includes("/") && !existsSync(e.command))) return { ok: false, found: true, detail: `capcomd's command in ${tildeOf(h.config)} doesn't exist (${e.command})`, hint: fix };
  const missing = Object.keys(HERMES_SKILLS).filter((n) => !existsSync(join(h.home, "skills", HERMES_SKILL_CATEGORY, n, "SKILL.md")));
  if (missing.length) return { ok: false, found: true, detail: `capcomd's MCP server is in Hermes, the skills aren't (${missing.join(", ")})`, hint: fix };
  const { readProjects } = require("../../config/projects") as typeof import("../../config/projects");
  const n = readProjects(env).list.length;
  const scope = typeof e.cwd === "string" ? ` pinned to ${tildeOf(e.cwd)} (re-run \`capcomd setup agent\` for one entry for all projects)` : ` for ${n} project${n === 1 ? "" : "s"}`;
  return { ok: true, found: true, detail: `capcomd in Hermes (${where}): MCP tools${scope} and skills` };
}
