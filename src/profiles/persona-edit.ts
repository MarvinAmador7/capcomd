// A profile's persona as text, read and written (GET and PUT /v1/profiles/{name}/persona, capability profiles.persona;
// ADR-024 §2.2 `identity.persona`, §5 "App"). The persona is prompt text, the first an agent of the profile reads
// (./persona.ts), so it is served by that one route only and never put in a row, an event or a log line.
// A write changes the profile's own directory only, never an ancestor's or an override's: its persona file when it
// names one, else a new SOUL.md beside its profile.yaml, named there as `identity.persona` (a single `<name>.yaml` is
// moved to `<name>/profile.yaml` first: a persona lives in a profile directory). The profile file's version goes up as
// with any write (./write.ts). A project's persona so changed is untrusted again by its new hash (./trust.ts): nothing
// here trusts it. An installed package's files are `capcomd profiles update`'s to replace, so they aren't written here.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { readLock } from "../install/lock";
import { agentsFilePath, writeAtomic, type ProfileSet, type ResolvedProfile } from "./load";
import { PERSONA_MAX_BYTES } from "./persona";
import { PROFILE_TRUST_KIND, projectPersonaTrust } from "./trust";
import { checked, current, editedManifest, ProfileWriteError } from "./write";

type Env = Record<string, string | undefined>;

/** The file a profile without a persona of its own gets. */
export const NEW_PERSONA_FILE = "SOUL.md";
const MANIFEST_FILE = /^profile\.(ya?ml|json)$/;

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A profile's persona as GET /v1/profiles/{name}/persona serves it. */
export interface PersonaView {
  file: string | null;
  text: string | null;
  /** `sha256:<hex>` of the text (of "" when there is none): PUT's `rev`. */
  hash: string;
  layer: string;
  editable: boolean;
  why: string | null;
  trusted: boolean;
}

/** Can PUT write this profile's persona, and if not, why (a daemon-written sentence). */
export function personaEditable(r: ResolvedProfile): { editable: true; why: null } | { editable: false; why: string } {
  const ownAt = r.applied.findIndex((a) => a.as === "profile");
  const own = r.applied[ownAt];
  const no = (why: string) => ({ editable: false as const, why });
  if (!own?.path) return no("It is bundled with capcomd, which a write doesn't change: add a profile of that name to your own profiles to give it a persona");
  if (r.format === "v1") return no(`It is an entry of ${basename(own.path)}, which can't name a persona: move it to a profile file (capcomd profiles migrate) first`);
  if (MANIFEST_FILE.test(basename(own.path)) && readLock(dirname(own.path))?.kind === PROFILE_TRUST_KIND)
    return no("It is an installed package (capcomd profiles install), whose files capcomd profiles update replaces: change it at its source");
  const by = r.setBy["identity.persona"];
  if (by !== undefined && by > ownAt) {
    const f = r.applied[by]!;
    return no(`${f.path ?? "A later file"} (${f.as === "override" ? `an override of ${f.name}` : f.as}) sets it after the profile's own file: change it there`);
  }
  return { editable: true, why: null };
}

/** The persona of resolved profile `r`, with whether PUT can change it and whether the operator trusts it. */
export function personaView(r: ResolvedProfile, env: Env = process.env): PersonaView {
  const p = r.persona, e = personaEditable(r);
  const trust = projectPersonaTrust(p, env);
  return {
    file: p?.file ?? null, text: p?.text ?? null, hash: sha(p?.text ?? ""), layer: p?.source ?? r.source,
    editable: e.editable, why: e.why, trusted: !trust || trust.trust === "trusted",
  };
}

export interface PersonaWrite {
  name: string;
  changed: boolean;
  /** The profile had no persona of its own (none, or its parent's): it has one now. */
  created: boolean;
  /** The persona file written, and the profile file that names it. */
  file: string;
  manifest: string;
  version: number;
  previousVersion: number;
  /** As the profile names it (SOUL.md). */
  personaFile: string;
  hash: string;
  after: ProfileSet;
}

/** Why a text can't be a persona, or null. */
export function personaTextProblem(text: string): string | null {
  if (!text.trim()) return "text: a persona can't be blank";
  const bytes = Buffer.byteLength(text);
  if (bytes > PERSONA_MAX_BYTES) return `text: ${bytes} bytes, over the ${PERSONA_MAX_BYTES} a persona may have`;
  return null;
}

/**
 * Write profile `name`'s persona (PUT /v1/profiles/{name}/persona): `rev` is the hash it was read at. Throws
 * ProfileWriteError (not_found, conflict, invalid with field text, read_only). The same text again writes nothing.
 */
export function writePersona(name: string, text: string, o: { path?: string; source?: Env; rev?: string } = {}): PersonaWrite {
  const path = o.path ?? agentsFilePath(), source = o.source ?? process.env;
  const before = current(path, source);
  const r = Object.hasOwn(before.profiles, name) ? before.profiles[name]! : undefined;
  if (!r) throw new ProfileWriteError("not_found", `profile "${name}" not found`);
  const e = personaEditable(r);
  if (!e.editable) throw new ProfileWriteError("read_only", `profile "${name}"'s persona can't be changed here: ${e.why}`);
  const was = sha(r.persona?.text ?? "");
  if (o.rev !== undefined && o.rev !== was) throw new ProfileWriteError("conflict", `profile "${name}"'s persona changed since it was read: read it again, then retry`);
  const bad = personaTextProblem(text);
  if (bad) throw new ProfileWriteError("invalid", bad, "text");
  const ownAt = r.applied.findIndex((a) => a.as === "profile");
  const ownPath = r.applied[ownAt]!.path!;
  const unchanged = (file: string, manifest: string): PersonaWrite => ({ name, changed: false, created: false, file, manifest, version: r.version, previousVersion: r.version, personaFile: r.persona!.file, hash: was, after: before });

  // Its own persona: the file is rewritten, then its profile file's version goes up.
  if (r.persona && r.setBy["identity.persona"] === ownAt) {
    if (r.persona.text === text) return unchanged(r.persona.path, ownPath);
    const m = editedManifest(ownPath, readFileSync(ownPath, "utf8"), {});
    writeAtomic(r.persona.path, text);
    writeAtomic(ownPath, m.text);
    return { name, changed: true, created: false, file: r.persona.path, manifest: ownPath, version: m.version, previousVersion: r.version, personaFile: r.persona.file, hash: sha(text), after: current(path, source) };
  }

  // None of its own (none, or its parent's): a SOUL.md in its own directory, named in its profile file.
  const single = !MANIFEST_FILE.test(basename(ownPath));
  const dir = single ? join(dirname(ownPath), name) : dirname(ownPath);
  const manifest = single ? join(dir, `profile${extname(ownPath)}`) : ownPath;
  if (single && existsSync(manifest)) throw new ProfileWriteError("conflict", `${manifest} already exists beside ${ownPath}: keep one`);
  const soul = join(dir, NEW_PERSONA_FILE);
  const old = readFileSync(ownPath, "utf8");
  const m = editedManifest(ownPath, old, { "identity.persona": NEW_PERSONA_FILE });
  const madeDir = !existsSync(dir);
  const soulBefore = existsSync(soul) ? readFileSync(soul, "utf8") : null;
  // Every state on the way is a valid one: the profile moved into its directory (unchanged), then a SOUL.md nothing
  // names yet, then the profile file that names it. A check that fails puts everything back.
  const undo = () => {
    if (soulBefore === null) rmSync(soul, { force: true }); else writeAtomic(soul, soulBefore);
    if (single && existsSync(manifest)) renameSync(manifest, ownPath);
    if (madeDir) try { rmdirSync(dir); } catch { /* something else is in it */ }
  };
  mkdirSync(dir, { recursive: true });
  try {
    if (single) renameSync(ownPath, manifest);
    writeAtomic(soul, text);
    checked(path, source, new Map([[manifest, m.text]]), before);
  } catch (err) { undo(); throw err; }
  writeAtomic(manifest, m.text);
  return { name, changed: true, created: true, file: soul, manifest, version: m.version, previousVersion: r.version, personaFile: NEW_PERSONA_FILE, hash: sha(text), after: current(path, source) };
}
