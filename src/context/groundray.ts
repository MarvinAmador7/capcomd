// A company's facts from a brain (ADR-025 §11.2, step 4; the `context-groundray` built-in, src/plugins/context-groundray.ts):
// the context provider `groundray`, read-only. A brain is a git repository holding an OKF bundle (groundray's: `brain.yaml`
// at its root naming the bundle `knowledge/`; any OKF producer's bundle in a directory works the same), so reads need
// neither the groundray CLI nor its catalog: capcomd reads the files at a pinned commit, through the same parser and
// lexical search as the project's memory (src/context/memory.ts).
//
// A profile names one brain by name (`context.providers: [{name: groundray, brain: acme}]`, never a path, ADR-024 §9);
// the project maps the name to a repository and pins it to a commit (`capcomd context brain add acme <repo>`, its
// .capcomd/config.json `context.brains`), and `run new` records the mappings with the run (src/context/project.ts), so
// every agent of a run reads the commit the run started with. One brain per handle and per brief: "a term in another
// company is not its local definition" (groundray's SKILL.md). A restricted brain (its bundle's `default_sensitivity`, or
// an item marked so) is refused when it is mapped and at every resolve: its files would be copied into agents' sandboxes
// (groundray keeps restricted material in a separately controlled repository; ADR-025 §8, D9).
//
// The router places the brain's tree at the cited commit in the agent's sandbox (resolve's `bundle`; the runner, through
// host git, src/merge/transfer.ts `sendTreeAt`), at `<bundleRoot>/groundray/<name>`, which is where each index line's
// path points. The write path (proposals as brain pull requests through the groundray CLI) is ADR-025 step 5.
import { existsSync } from "fs";
import { PluginError } from "../../packages/plugin/src/errors";
import type { SeamCall } from "../../packages/plugin/src/seams";
import { bundleDir, type ContextDescriptor, type ContextHit, type ContextItem, type ContextProvider, type ContextRef, type ContextScope, type ContextSearch } from "../../packages/plugin/src/context-layer";
import type { ContextBrain } from "../config/store";
import { RelayError } from "../core/errors";
import { assertRemoteUrl, inlineCredential } from "../merge/host-git";
import { aborted, classifyContextError, contextItem, mirrorReader, parseBundle, searchItems, type Parsed, type TreeReader } from "./memory";
import { contextSettings, type ContextSettings } from "./project";

export const GROUNDRAY = "groundray";
/** A brain's name, as a profile and the project's mapping write it. */
export const BRAIN_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** groundray's brain.yaml schema 1 (its schemas/brain.schema.yaml): the slug and the UUID v4 identity. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BRAIN_ID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A bundle directory in the brain's repository: plain names, no `..`. */
const BUNDLE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

export interface BrainManifest { slug: string; id: string; name: string; bundle: string }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** brain.yaml as groundray's closed schema 1 has it, or why it isn't. */
export function parseBrainManifest(text: string): { ok: true; manifest: BrainManifest } | { ok: false; problem: string } {
  let v: unknown;
  const { parse } = require("yaml") as typeof import("yaml");
  try { v = parse(text, { maxAliasCount: 0, prettyErrors: false }); } catch { return { ok: false, problem: "brain.yaml isn't YAML" }; }
  if (!isMap(v)) return { ok: false, problem: "brain.yaml isn't a mapping" };
  const extra = Object.keys(v).filter((k) => !["schema_version", "id", "slug", "name", "bundle"].includes(k));
  if (v.schema_version !== 1) return { ok: false, problem: "brain.yaml's schema_version isn't 1" };
  if (extra.length) return { ok: false, problem: `brain.yaml has fields schema 1 doesn't (${extra.join(", ")})` };
  if (typeof v.id !== "string" || !BRAIN_ID.test(v.id)) return { ok: false, problem: "brain.yaml's id isn't a urn:uuid (v4)" };
  if (typeof v.slug !== "string" || !SLUG.test(v.slug) || v.slug.length < 2 || v.slug.length > 63) return { ok: false, problem: "brain.yaml's slug isn't lowercase kebab-case" };
  if (typeof v.name !== "string" || v.name.trim().length < 2 || v.name.length > 100) return { ok: false, problem: "brain.yaml's name is missing" };
  if (v.bundle !== "knowledge") return { ok: false, problem: "brain.yaml's bundle isn't knowledge" };
  return { ok: true, manifest: { slug: v.slug, id: v.id, name: v.name.trim(), bundle: "knowledge" } };
}

/** One brain at one commit, as read from its repository. */
export interface BrainTree {
  commit: string;
  date: string;
  /** Its brain.yaml (null: an OKF bundle without one). */
  manifest: BrainManifest | null;
  /** The bundle directory, `knowledge` for a groundray brain. */
  bundle: string;
  /** Its bundle's `.core-kb.yaml` `default_sensitivity`, when it says. */
  sensitivity: string | null;
  /** Why it is restricted (refused), or null. */
  restricted: string | null;
  /** Its items, at their paths in the repository. */
  parsed: Parsed;
  truncated: boolean;
}

/** The brain in `remote` at a branch's tip or a commit: brain.yaml at its root, then its bundle at that commit. */
export async function readBrain(read: TreeReader, remote: string, at: { branch: string } | { sha: string }, o: { runId?: string | null; bundle?: string } = {}): Promise<BrainTree | { error: string }> {
  const runId = o.runId ?? null;
  const head = await read({ remote, at, runId, prefix: "brain.yaml" });
  if ("error" in head) return head;
  const yaml = head.files.find((f) => f.path === "brain.yaml");
  let manifest: BrainManifest | null = null;
  if (yaml) {
    const m = parseBrainManifest(yaml.text ?? "");
    if (!m.ok) return { error: m.problem };
    manifest = m.manifest;
  }
  const bundle = manifest?.bundle ?? o.bundle ?? "knowledge";
  if (!BUNDLE.test(bundle)) return { error: `${JSON.stringify(bundle).slice(0, 80)} isn't a directory in the repository` };
  const config = `${bundle}/.core-kb.yaml`;
  const t = await read({ remote, at: { sha: head.sha }, runId, prefix: `${bundle}/`, only: (p) => p.endsWith(".md") || p === config });
  if ("error" in t) return t;
  const parsed = parseBundle(t.files, { revision: head.sha, date: head.date }, { provider: GROUNDRAY, root: `${bundle}/`, kindOf: () => "fact", shown: (p) => p, defaultType: () => "fact", requireType: true });
  if (!yaml && !parsed.items.length) return { error: `no brain.yaml, and no OKF items under ${bundle}/` };
  const cfg = t.files.find((f) => f.path === config);
  let sensitivity: string | null = null;
  if (cfg?.text) {
    const { parse } = require("yaml") as typeof import("yaml");
    try { const c = parse(cfg.text, { maxAliasCount: 0, prettyErrors: false }); if (isMap(c) && typeof c.default_sensitivity === "string") sensitivity = c.default_sensitivity; } catch { /* not YAML: says nothing */ }
  }
  const marked = parsed.items.filter((i) => i.sensitivity === "restricted").length;
  const restricted = sensitivity === "restricted" ? "its bundle's default sensitivity is restricted"
    : marked ? `${marked} of its items ${marked === 1 ? "is" : "are"} marked restricted` : null;
  return { commit: head.sha, date: head.date, manifest, bundle, sensitivity, restricted, parsed, truncated: t.truncated };
}

/** A project's mapping, as `run new` recorded it (or the file has it): checked, since the file is hand-editable. */
function mappingOf(settings: ContextSettings, name: string): ContextBrain | null {
  const b = (settings.brains as Record<string, unknown> | undefined)?.[name];
  if (!isMap(b) || typeof b.repo !== "string" || !b.repo || typeof b.commit !== "string" || !COMMIT.test(b.commit)) return null;
  if (typeof b.branch !== "string" || !BRANCH.test(b.branch) || typeof b.slug !== "string" || typeof b.id !== "string") return null;
  if (inlineCredential(b.repo)) return null;
  return b as unknown as ContextBrain;
}

interface Handle { name: string; remote: string; commit: string; branch: string; bundle: string; dir: string | null }

/** `context:groundray` (ADR-025 §11.2). `read`: how a tree is read (the files mirror; a test's fixture). `settings`: the
 *  project settings a run was started with (src/context/project.ts; a test's own). */
export function groundrayProvider(o: { read?: TreeReader; settings?: (runId: string | null) => Promise<ContextSettings> } = {}): ContextProvider {
  const read = o.read ?? mirrorReader;
  const settingsOf = o.settings ?? contextSettings;
  /** Brains read, by (repository, commit): a commit's tree never changes. */
  const cache = new Map<string, BrainTree>();
  const reading = new Map<string, Promise<BrainTree | { error: string }>>();
  const handleOf = (h: string): Handle => {
    try { const v = JSON.parse(h) as Handle; if (typeof v.remote === "string" && typeof v.commit === "string" && typeof v.name === "string") return v; } catch { /* below */ }
    throw new PluginError("invalid", "not a handle this provider made");
  };
  /** The brain at the mapping's commit: from memory, else read once however many agents ask at once. A remote that won't
   *  serve a commit by name is fetched at the mapped branch, which has it. */
  const brainAt = async (m: { repo: string; commit: string; branch: string; bundle?: string }, runId: string | null): Promise<BrainTree> => {
    const key = `${m.repo}\0${m.commit}`;
    const had = cache.get(key);
    if (had) return had;
    let p = reading.get(key);
    if (!p) {
      p = (async () => {
        const first = await readBrain(read, m.repo, { sha: m.commit }, { runId, ...(m.bundle ? { bundle: m.bundle } : {}) });
        if (!("error" in first)) return first;
        const tip = await read({ remote: m.repo, at: { branch: m.branch }, runId, prefix: "brain.yaml" });
        return "error" in tip ? first : readBrain(read, m.repo, { sha: m.commit }, { runId, ...(m.bundle ? { bundle: m.bundle } : {}) });
      })();
      reading.set(key, p);
      const done = () => { if (reading.get(key) === p) reading.delete(key); };
      p.then(done, done);
    }
    const t = await p;
    if ("error" in t) throw new PluginError("unavailable", t.error);
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, t);
    return t;
  };
  const shownPath = (h: Handle, path: string) => (h.dir ? `${h.dir}/${path}` : `${h.name}@${h.commit.slice(0, 12)}:${path}`);
  const descriptor: ContextDescriptor = {
    name: GROUNDRAY, descriptorVersion: 1, label: "Business knowledge (a groundray brain)", vendor: "capcomd",
    caps: { kinds: ["fact"], layers: ["project"], writable: false, search: ["lexical"], bundle: true }, trainedFor: null,
  };
  return {
    describe: () => structuredClone(descriptor),
    // Reads need no groundray binary (D9): the CLI is for proposals, ADR-025 step 5.
    async available() { return { ok: true }; },
    classifyError: classifyContextError,
    async resolve(scope: ContextScope, c: SeamCall) {
      aborted(c);
      const brain = scope.settings?.brain;
      if (typeof brain !== "string" || !BRAIN_NAME.test(brain))
        throw new PluginError("invalid", Array.isArray(brain) ? "a profile names one brain: two brains are never in one brief" : "the profile names no brain", "Name one: context.providers: [{name: groundray, brain: <name>}].");
      const m = mappingOf(await settingsOf(scope.runId), brain);
      aborted(c);
      if (!m) throw new PluginError("invalid", `the project maps no brain ${brain}`, `Map it: capcomd context brain add ${brain} <repository>`);
      const t = await brainAt(m, scope.runId);
      aborted(c);
      // The repository at the pinned commit must still be the brain that was mapped, and still not restricted.
      if (t.manifest ? t.manifest.id !== m.id || t.manifest.slug !== m.slug : !!m.id) throw new PluginError("invalid", `the repository mapped as brain ${brain} isn't the brain it was at ${m.commit.slice(0, 12)}`);
      if (t.restricted) throw new PluginError("invalid", `brain ${brain} is restricted at ${m.commit.slice(0, 12)}: ${t.restricted}`);
      const dir = scope.bundleRoot ? bundleDir(scope.bundleRoot, GROUNDRAY, brain) : null;
      const h: Handle = { name: brain, remote: m.repo, commit: t.commit, branch: m.branch, bundle: t.bundle, dir };
      return { handle: JSON.stringify(h), revision: t.commit, ...(dir ? { bundle: { remote: m.repo, branch: m.branch, commit: t.commit, name: brain } } : {}) };
    },
    async index(handle: string, c: SeamCall) {
      aborted(c);
      const h = handleOf(handle);
      const t = await brainAt({ repo: h.remote, commit: h.commit, branch: h.branch, bundle: h.bundle }, null);
      return { revision: t.commit, modified: t.parsed.modified, lines: t.parsed.items.map((i) => ({ ...structuredClone(i.line), path: shownPath(h, i.line.path) })) };
    },
    async search(handle: string, q: ContextSearch, c: SeamCall): Promise<ContextHit[]> {
      aborted(c);
      const h = handleOf(handle);
      return searchItems((await brainAt({ repo: h.remote, commit: h.commit, branch: h.branch, bundle: h.bundle }, null)).parsed.items, q);
    },
    async get(handle: string, ref: ContextRef, c: SeamCall): Promise<ContextItem> {
      aborted(c);
      const h = handleOf(handle);
      const i = (await brainAt({ repo: h.remote, commit: h.commit, branch: h.branch, bundle: h.bundle }, null)).parsed.items.find((x) => x.line.ref.id === ref.id);
      if (!i || ref.provider !== GROUNDRAY) throw new PluginError("not_found", `no item ${ref.id} in brain ${h.name} at ${h.commit.slice(0, 12)}`);
      // A brain is shared across projects: its items belong to none.
      return contextItem({ ...i, line: { ...i.line, path: shownPath(h, i.line.path) } }, { provider: GROUNDRAY, revision: h.commit, projectId: null });
    },
    async propose() {
      throw new PluginError("unsupported", "a brain is read-only here for now: proposals to it come with groundray's write path (ADR-025 step 5)");
    },
  };
}

// ---- the project's mappings (`capcomd context brain …`) ---------------------------------------------------------

type Env = Record<string, string | undefined>;

/** The project's config file (.capcomd/config.json, the nearest from `cwd`), or a config error naming what to do. */
function projectFile(cwd: string, env: Env): string {
  const { projectConfigPath } = require("../config/store") as typeof import("../config/store");
  const p = projectConfigPath(cwd, env);
  if (!p || !existsSync(p)) throw new RelayError("config", `${cwd} isn't in a capcomd project (no .capcomd/config.json in it or above it)`, "Run `capcomd setup project` in the project's checkout first.");
  return p;
}

/** The brains the project maps, by name. */
export function listBrains(cwd = process.cwd(), env: Env = process.env): { path: string; brains: Record<string, ContextBrain> } {
  const path = projectFile(cwd, env);
  const { readConfig } = require("../config/store") as typeof import("../config/store");
  return { path, brains: { ...(readConfig(path).context?.brains ?? {}) } };
}

function writeBrains(path: string, brains: Record<string, ContextBrain>): void {
  const { readConfig, writeConfig } = require("../config/store") as typeof import("../config/store");
  const cur = readConfig(path).context ?? {};
  const next = { ...cur, brains };
  if (!Object.keys(brains).length) delete (next as { brains?: unknown }).brains;
  writeConfig(path, { context: next });
}

export interface AddedBrain { name: string; brain: ContextBrain; previous: ContextBrain | null; path: string; items: number; truncated: boolean }

/**
 * `capcomd context brain add <name> <repo>`: read the brain at its branch's tip (the repository's default branch unless
 * one is named), check it (groundray's brain.yaml, else an OKF bundle with items; never restricted), and map `name` to
 * it pinned at that commit in the project's config. Mapping a name again to the same repository moves its pin to the
 * tip; to another repository is refused (remove it first). A restricted brain is refused here, before anything is kept.
 */
export async function addBrain(o: { name: string; repo: string; branch?: string; bundle?: string; cwd?: string; env?: Env; read?: TreeReader; defaultBranch?: (repo: string) => Promise<string | null>; now?: () => Date }): Promise<AddedBrain> {
  const env = o.env ?? process.env;
  const path = projectFile(o.cwd ?? process.cwd(), env);
  if (!BRAIN_NAME.test(o.name)) throw new RelayError("usage", `brain name ${JSON.stringify(o.name).slice(0, 80)} isn't lowercase letters, digits, - and _`, "Name it as profiles will: capcomd context brain add acme <repository>.");
  const repo = o.repo.trim();
  if (inlineCredential(repo)) throw new RelayError("usage", "the repository URL has a credential in it", "Give its URL without one: capcomd's host git uses your forge login or git's own credential helpers.");
  try { assertRemoteUrl(repo); } catch (e) { throw new RelayError("usage", (e as Error).message, "Give the brain's repository URL or path."); }
  if (o.branch !== undefined && !BRANCH.test(o.branch)) throw new RelayError("usage", `bad --branch ${JSON.stringify(o.branch).slice(0, 80)}`, "Name a branch, e.g. --branch main.");
  if (o.bundle !== undefined && !BUNDLE.test(o.bundle)) throw new RelayError("usage", `bad --bundle ${JSON.stringify(o.bundle).slice(0, 80)}`, "Name the bundle's directory in the repository, e.g. --bundle knowledge.");
  const { brains } = listBrains(o.cwd ?? process.cwd(), env);
  const previous = brains[o.name] ?? null;
  if (previous && previous.repo !== repo) throw new RelayError("conflict", `brain ${o.name} is mapped to ${previous.repo}`, `Remove it first: capcomd context brain remove ${o.name}`);
  const branch = o.branch ?? previous?.branch ?? (await (o.defaultBranch ?? ((r: string) => import("../merge/host-git").then((g) => g.remoteDefaultBranch(r, { timeoutMs: 60_000 }))))(repo)) ?? "main";
  const t = await readBrain(o.read ?? mirrorReader, repo, { branch }, o.bundle ? { bundle: o.bundle } : {});
  if ("error" in t) throw new RelayError("config", `can't read brain ${o.name} from ${repo} (${branch}): ${t.error}`, "Check the repository and branch: it needs groundray's brain.yaml, or an OKF bundle (--bundle <dir>).");
  if (t.restricted) throw new RelayError("config", `brain ${o.name} is restricted (${t.restricted}), so capcomd won't add it: its files would be copied into agents' sandboxes`, "Keep restricted knowledge in its own controlled repository, outside capcomd; map a brain that isn't restricted.", { code: "restricted" });
  if (previous && t.manifest && (previous.id !== t.manifest.id || previous.slug !== t.manifest.slug)) throw new RelayError("conflict", `the repository mapped as brain ${o.name} now holds another brain (${t.manifest.slug})`, `Remove it first: capcomd context brain remove ${o.name}`);
  const brain: ContextBrain = {
    repo, branch, commit: t.commit, slug: t.manifest?.slug ?? o.name, id: t.manifest?.id ?? "", ...(t.manifest ? { title: t.manifest.name } : {}),
    ...(t.bundle !== "knowledge" ? { bundle: t.bundle } : {}), addedAt: (o.now?.() ?? new Date()).toISOString(),
  };
  writeBrains(path, { ...brains, [o.name]: brain });
  return { name: o.name, brain, previous, path, items: t.parsed.items.length, truncated: t.truncated };
}

/** `capcomd context brain remove <name>`: the mapping only; the brain's repository is never touched. */
export function removeBrain(name: string, cwd = process.cwd(), env: Env = process.env): { path: string; removed: ContextBrain } {
  const { path, brains } = listBrains(cwd, env);
  const removed = brains[name];
  if (!removed) throw new RelayError("not_found", `the project maps no brain ${name}`, "See its brains: capcomd context brain list");
  delete brains[name];
  writeBrains(path, brains);
  return { path, removed };
}
