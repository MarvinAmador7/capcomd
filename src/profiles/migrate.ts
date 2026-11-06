// `capcomd profiles migrate` (ADR-024 §6, §7 step 9): an agents.json's entries (v1) written as profile files (v2) in
// the profiles/ folder of the same layer (.capcomd/agents.json → .capcomd/profiles/<name>.yaml; the user's
// ~/.capcomd/agents.json → ~/.capcomd/profiles/), each at version 1 with the entry's own values where v2 keeps them, so
// every profile resolves exactly as before: checked through the loader's overlay before anything is written, and
// refused when any profile would pin another spec. agents.json stays where it is, with a note saying where its
// profiles went (`keep`: untouched, entries and all, for a capcomd that reads only agents.json; a profile file wins).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { agentsFilePath, agentsFileText, BUNDLED_PROFILES, LOOKS_LIKE_FILE, profileLayers, readProfiles, writeAtomic, type ProfileSet } from "./load";
import { AgentConfigError, AGENTS_SCHEMA, type AgentsFile } from "./v1";
import { fromFlat, PROFILE_SCHEMA, type ProfileDoc } from "./v2";
import { profileFileText, ProfileWriteError } from "./write";

type Env = Record<string, string | undefined>;

export interface Migration {
  /** The agents.json read. */
  file: string;
  /** The profiles/ folder the profiles went to. */
  dir: string;
  /** Each profile moved, to `<dir>/<name>.yaml`; `default`: its file says `default: true`, as agents.json said. */
  migrated: Array<{ name: string; path: string; default: boolean }>;
  /** Entries left in agents.json as they are (still read), and why: a profile file of the same name already hides it,
   *  or a prompt a profile file would read as a file's name. */
  left: Array<{ name: string; why: string }>;
  /** What became of agents.json: `updated` (the moved entries gone, a note in their place), `kept` (as it was), or
   *  `none` (nothing was moved). */
  agentsFile: "updated" | "kept" | "none";
  /** Nothing was written (dryRun, or nothing to move). */
  dryRun: boolean;
}

/** The note migrate leaves in agents.json: where the profiles went, and that the file is still read. */
export const migratedNote = (dir: string) =>
  `Its profiles moved to ${dir} (capcomd profiles migrate). capcomd still reads this file until a later release (see the changelog), and a profile file of the same name wins.`;
const HEADER = "Moved from agents.json by `capcomd profiles migrate`. `capcomd profiles show <name>` says where each value comes from.";

/**
 * Move the agents file's entries into profile files (`capcomd profiles migrate`). Throws ProfileWriteError `invalid`
 * when the profiles can't be read as they are, or wouldn't resolve the same after.
 */
export function migrateProfiles(o: { path?: string; source?: Env; keep?: boolean; dryRun?: boolean } = {}): Migration {
  const path = o.path ?? agentsFilePath(), source = o.source ?? process.env;
  const { dir, layer } = profileLayers(path, source)[0]!;
  let before: ProfileSet;
  try { before = readProfiles(path, source); } catch (e) {
    if (e instanceof AgentConfigError) throw new ProfileWriteError("invalid", `the profiles can't be read, so nothing was migrated: ${e.message}`);
    throw e;
  }
  const result: Migration = { file: path, dir, migrated: [], left: [], agentsFile: "none", dryRun: true };
  if (!existsSync(path)) return result;
  // As written (not resolved: an override of an entry stays an override, laid over its new file as it was over it).
  const v1 = JSON.parse(readFileSync(path, "utf8")) as AgentsFile;
  const entries = Object.entries(v1.agents ?? {});

  const overlay = new Map<string, string>();
  for (const [name, spec] of entries) {
    const r = before.profiles[name];
    if (r && r.format === "v2" && r.source === layer) { result.left.push({ name, why: `${r.path ?? "a profile file"} hides it already` }); continue; }
    // A prompt that is one word ending .md or .txt is a file's name in a profile file, and a single file can't hold one.
    const doc: ProfileDoc = { schema: PROFILE_SCHEMA, ...fromFlat(name, spec), version: 1, ...(v1.default === name && before.default === name ? { default: true } : {}) };
    if ([spec.systemPrompt, spec.appendSystemPrompt].some((t) => typeof t === "string" && LOOKS_LIKE_FILE.test(t))) {
      result.left.push({ name, why: "a prompt of it is one word ending .md or .txt, which a profile file reads as a file's name (move it by hand, as <name>/profile.yaml with the prompt in a file)" });
      continue;
    }
    // No file is in the way: one named for it in this layer is a profile file, which hides the entry (above).
    const file = join(dir, `${name}.yaml`);
    overlay.set(file, profileFileText(doc, HEADER));
    result.migrated.push({ name, path: file, default: doc.default === true });
  }
  if (!result.migrated.length) return result;

  // agents.json: the moved entries gone, its default with them (the moved profile's `default: true` now); entries left
  // and a default naming one of them are kept.
  const gone = new Set(result.migrated.map((m) => m.name));
  if (!o.keep) {
    const next: AgentsFile = { $comment: migratedNote(dir), schema: AGENTS_SCHEMA, agents: Object.fromEntries(entries.filter(([n]) => !gone.has(n))), ...(v1.default !== undefined && !gone.has(v1.default) ? { default: v1.default } : {}) };
    overlay.set(path, agentsFileText(next));
  }

  // Every profile resolves as before: the same spec, version, runtime and skills, and the same default.
  let after: ProfileSet;
  try { after = readProfiles(path, source, BUNDLED_PROFILES, overlay); } catch (e) {
    if (e instanceof AgentConfigError) throw new ProfileWriteError("invalid", `the profile files wouldn't resolve, so nothing was migrated: ${e.message}`);
    throw e;
  }
  const changed = Object.keys(before.profiles).filter((n) => {
    const x = before.profiles[n]!, y = after.profiles[n];
    return !y || x.version !== y.version || !isDeepStrictEqual(x.spec, y.spec) || !isDeepStrictEqual(x.runtime, y.runtime) || !isDeepStrictEqual(x.skills.map((s) => s.hash), y.skills.map((s) => s.hash));
  });
  if (changed.length || before.default !== after.default)
    throw new ProfileWriteError("invalid", `migrating would change ${changed.length ? `profile ${changed.join(", ")}` : `the default profile (${before.default ?? "none"} → ${after.default ?? "none"})`}, so nothing was migrated: move ${changed.length === 1 ? "it" : "them"} by hand (capcomd profiles schema prints a profile file's schema)`);

  Object.assign(result, { agentsFile: o.keep ? "kept" : "updated", dryRun: !!o.dryRun });
  if (o.dryRun) return result;
  // The profile files first, agents.json last: a migration cut short leaves profile files that win over entries still there.
  for (const [file, text] of overlay) if (file !== path) writeAtomic(file, text);
  if (overlay.has(path)) writeAtomic(path, overlay.get(path)!);
  return result;
}
