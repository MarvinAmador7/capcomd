// A profile's persona (ADR-024 §2.2 `identity.persona`, decision 4): a text file in the profile's directory that says
// who its agents are, read when the profile resolves and pinned on the agent at spawn by its sha256, as its skills are
// (./skills.ts; src/primitives/ops.ts `spawnAgent`). Its text is kept with the run (a content-addressed attachment), and
// agent.preparing (plugin API §6.6.7) gives it to every attempt checked against the pin, as the first text of the
// agent's instructions (src/agents/runner.ts): before its profile's own prompt, its skills and what plugins add. A
// project's persona is text the repository supplies, so an agent of it is spawned only once the operator has trusted
// it as it is (./trust.ts, the skills' mechanism). It is inherited (ADR-024 §2.3): the file is read from the directory
// of the manifest that named it, an ancestor's or an override's.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { AppliedFile } from "./load";
import type { ProfileDoc, SetBy } from "./v2";

/** At most this many bytes: a persona says who the agent is, in a page or two (a skill may have 256 KB). */
export const PERSONA_MAX_BYTES = 32 * 1024;

/** A persona as pinned on an agent (its spec's `persona`): the layer it came from and the sha256 (hex) of its text. */
export interface PersonaPin { source: "project" | "user"; hash: string }
/** A profile's persona, resolved: its pin, its text, the file (as the manifest names it, and where it is). */
export interface ProfilePersona extends PersonaPin { file: string; path: string; text: string }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A resolved manifest's `identity.persona`, read from the directory of the file in `applied` that set it (`setBy`).
 * The loader checked the name when it read that file (src/profiles/load.ts readFiles); it is checked again here, where
 * it is read. Errors are `<prefix>: identity.persona …`, as a profile's others are.
 */
export function profilePersona(prefix: string, doc: ProfileDoc, setBy: SetBy, applied: readonly AppliedFile[]): { persona: ProfilePersona | null; errors: string[] } {
  const file = isMap(doc.identity) ? doc.identity.persona : undefined;
  if (typeof file !== "string") return { persona: null, errors: [] };
  const fail = (m: string) => ({ persona: null, errors: [`${prefix}: identity.persona ${m}`] });
  const from = applied[setBy["identity.persona"] ?? -1];
  if (!from?.path || from.layer === "bundled") return fail(`names ${file}, which only a profile directory (<name>/profile.yaml) can hold`);
  const dir = dirname(from.path);
  let real: string;
  try { real = realpathSync(join(dir, file)); } catch { return fail(`names ${file}, which isn't in ${dir}`); }
  if (!real.startsWith(realpathSync(dir) + sep) || !statSync(real).isFile()) return fail(`names ${file}, which leads outside the profile's directory`);
  const text = readFileSync(real, "utf8");
  const bytes = Buffer.byteLength(text);
  if (!text.trim()) return fail(`(${file}) is empty`);
  if (bytes > PERSONA_MAX_BYTES) return fail(`(${file}) is ${bytes} bytes, over the ${PERSONA_MAX_BYTES} a persona may have`);
  return { persona: { source: from.layer, hash: sha256(text), file, path: join(dir, file), text }, errors: [] };
}

/** The persona pinned on an agent's spec at spawn (`spec.persona`), or null when there is none or the record isn't one. */
export function pinnedPersona(spec: unknown): PersonaPin | null {
  const p = isMap(spec) ? spec.persona : undefined;
  if (!isMap(p) || typeof p.hash !== "string" || !/^[0-9a-f]{64}$/.test(p.hash) || (p.source !== "project" && p.source !== "user")) return null;
  return { source: p.source, hash: p.hash };
}
