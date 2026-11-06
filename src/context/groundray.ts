// A company's facts from a brain (ADR-025 §11.2, step 4; the `context-groundray` built-in, src/plugins/context-groundray.ts):
// the context provider `groundray`. A brain is a git repository holding an OKF bundle (groundray's: `brain.yaml`
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
// path points.
//
// Writable (ADR-025 step 5, ./groundray-write.ts): `propose` makes a draft item through the groundray CLI in a
// throwaway authoring clone, pushes it to the run's proposal branch of the brain's repository and opens a pull request
// there through the forge that serves it, as the person who sent it (else capcomd). Only new drafts (`add`): a brain's
// items change, and are promoted, by its owners' review in groundray's own flow. What agents read is never touched.
import { existsSync } from "fs";
import { join, resolve as resolvePath } from "path";
import { PluginError } from "../../packages/plugin/src/errors";
import type { SeamCall } from "../../packages/plugin/src/seams";
import { bundleDir, type ContextDescriptor, type ContextHit, type ContextItem, type ContextProposal, type ContextProvider, type ContextRef, type ContextScope, type ContextSearch, type ProposalReceipt } from "../../packages/plugin/src/context-layer";
import type { ContextBrain } from "../config/store";
import { RelayError } from "../core/errors";
import { assertRemoteUrl, inlineCredential } from "../merge/host-git";
import type { Principal } from "../../packages/plugin/src/shapes";
import { actorOf, BRAIN_NAME_RE, draftProblem, groundrayBin, writeToBrain, type BrainDraft, type BrainTarget, type BrainWritten, type WriteDeps } from "./groundray-write";
import { aborted, classifyContextError, contextItem, MEMORY_MAX_FILES, mirrorReader, parseBundle, searchItems, type Parsed, type TreeReader } from "./memory";
import { contextSettings, type ContextSettings } from "./project";

export const GROUNDRAY = "groundray";
/** A brain's name, as a profile and the project's mapping write it. */
export const BRAIN_NAME = BRAIN_NAME_RE;
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
  /** Why capcomd couldn't check that it isn't (refused too), or null. */
  unchecked: string | null;
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
  // The whole tree is placed in agents' sandboxes, so every file read is checked, an item or not (no `type`, an id seen
  // already, index.md), as text (a frontmatter whose YAML won't parse still says it); one too big to parse is read again
  // for the check alone. A tree capcomd couldn't read whole isn't known not to be restricted.
  let checked = t.files;
  const big = new Set(t.files.filter((f) => f.text === null).map((f) => f.path));
  if (big.size) {
    const again = await read({ remote, at: { sha: head.sha }, runId, prefix: `${bundle}/`, only: (p) => big.has(p), maxBytes: BRAIN_CHECK_MAX_BYTES });
    if ("error" in again) return again;
    checked = [...t.files.filter((f) => f.text !== null), ...again.files];
  }
  const cfg = checked.find((f) => f.path === config);
  let sensitivity: string | null = null;
  if (cfg?.text) {
    const { parse } = require("yaml") as typeof import("yaml");
    try { const c = parse(cfg.text, { maxAliasCount: 0, prettyErrors: false }); if (isMap(c) && typeof c.default_sensitivity === "string") sensitivity = c.default_sensitivity.trim(); } catch { /* not YAML: its line, below */ }
    if (sensitivity === null && /^default_sensitivity[ \t]*:[ \t]*(["']?)restricted\1[ \t]*(?:#.*)?$/im.test(cfg.text)) sensitivity = "restricted";
  }
  const marked = checked.filter((f) => f.text !== null && f.path !== config && marksRestricted(f.text)).length;
  const restricted = sensitivity?.toLowerCase() === "restricted" ? "its bundle's default sensitivity is restricted"
    : marked ? `${marked} of its files ${marked === 1 ? "is" : "are"} marked restricted` : null;
  const unread = checked.filter((f) => f.text === null).length;
  const unchecked = t.truncated ? `it has more than ${MEMORY_MAX_FILES} files under ${bundle}/, more than capcomd reads`
    : unread ? `${unread} of its files ${unread === 1 ? "is" : "are"} over ${BRAIN_CHECK_MAX_BYTES / 1024 / 1024} MiB` : null;
  return { commit: head.sha, date: head.date, manifest, bundle, sensitivity, restricted, unchecked, parsed, truncated: t.truncated };
}

/** The most capcomd reads of one file of a brain to check its sensitivity (an item is parsed up to MEMORY_MAX_BYTES). */
const BRAIN_CHECK_MAX_BYTES = 4 * 1024 * 1024;
/** Whether a file's frontmatter says `sensitivity: restricted` (OKF's handling hint), in any case. */
function marksRestricted(text: string): boolean {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return !!m && /^sensitivity[ \t]*:[ \t]*(["']?)restricted\1[ \t]*(?:#.*)?$/im.test(m[1]!);
}

/** A project's mapping, as `run new` recorded it (or the file has it): checked, since the file is hand-editable. */
function mappingOf(settings: ContextSettings, name: string): ContextBrain | null {
  const b = (settings.brains as Record<string, unknown> | undefined)?.[name];
  if (!isMap(b) || typeof b.repo !== "string" || !b.repo || typeof b.commit !== "string" || !COMMIT.test(b.commit)) return null;
  if (typeof b.branch !== "string" || !BRANCH.test(b.branch) || typeof b.slug !== "string" || typeof b.id !== "string") return null;
  if (inlineCredential(b.repo)) return null;
  return b as unknown as ContextBrain;
}

/** What a handle binds: the brain at a commit, and the run and agent it was resolved for (a proposal's origin). */
interface Handle { name: string; remote: string; commit: string; branch: string; bundle: string; dir: string | null; slug?: string; id?: string; runId?: string | null; agentId?: string | null }

/** How a proposal is written to a brain (./groundray-write.ts; a test's own). */
export type BrainWriter = (brain: BrainTarget, draft: BrainDraft, actor: string, c: SeamCall) => Promise<BrainWritten>;

/** The pull request for a proposal branch, through the forge that serves the brain's repository (its own remote, not
 *  the run's): an open one found, else opened; null when no forge there opens pull requests (forge-git's kind). */
export const forgePullRequest: WriteDeps["pullRequest"] = async (input, c) => {
  const F = await import("../plugins/forges");
  const forge = await F.forgeFor({ remote: input.remote });
  if (!forge || !forge.describe().pullRequests) return null;
  return F.forgeScope.run({}, async () => {
    const found = await forge.findPullRequest({ remote: input.remote, head: input.head, base: input.base }, c);
    const p = found && found.state === "open" ? found : await forge.openPullRequest(input, c);
    return { number: p.number, url: p.url };
  });
};

/** The write path on this host: the groundray CLI, a throwaway directory where capcomd keeps its clones, the forge that
 *  serves the brain's repository for the pull request. */
export const hostWriter: BrainWriter = async (brain, draft, actor, c) => {
  const bin = groundrayBin();
  if (!bin) throw new PluginError("unavailable", "the groundray CLI isn't on this machine: proposals to a brain go through it", "Install groundray (https://github.com/MarvinAmador7/groundray), or name it with CAPCOMD_GROUNDRAY=<path>.");
  const { runEnv } = await import("../merge/run-config");
  const { loadMergeConfig } = await import("../merge/config");
  const cfg = loadMergeConfig({ ...(await runEnv(draft.origin.runId)), CAPCOMD_REPO: brain.repo });
  if (!cfg) throw new PluginError("unavailable", `can't work with ${brain.repo}`);
  return writeToBrain(brain, draft, actor, { bin, workdir: join(cfg.workdir, "brain-proposals"), pullRequest: forgePullRequest }, c);
};

/** `context:groundray` (ADR-025 §11.2). `read`: how a tree is read (the files mirror; a test's fixture). `settings`: the
 *  project settings a run was started with (src/context/project.ts; a test's own). `write`: how a proposal is written. */
export function groundrayProvider(o: { read?: TreeReader; settings?: (runId: string | null) => Promise<ContextSettings>; write?: BrainWriter } = {}): ContextProvider {
  const read = o.read ?? mirrorReader;
  const settingsOf = o.settings ?? contextSettings;
  const write = o.write ?? hostWriter;
  /** Brains read, by (repository, commit, bundle): a commit's tree never changes. */
  const cache = new Map<string, BrainTree>();
  const reading = new Map<string, Promise<BrainTree | { error: string }>>();
  const handleOf = (h: string): Handle => {
    try { const v = JSON.parse(h) as Handle; if (typeof v.remote === "string" && typeof v.commit === "string" && typeof v.name === "string") return v; } catch { /* below */ }
    throw new PluginError("invalid", "not a handle this provider made");
  };
  /** The brain at the mapping's commit: from memory, else read once however many agents ask at once. A remote that won't
   *  serve a commit by name is fetched at the mapped branch, which has it. */
  const brainAt = async (m: { repo: string; commit: string; branch: string; bundle?: string }, runId: string | null): Promise<BrainTree> => {
    const key = `${m.repo}\0${m.commit}\0${m.bundle || "knowledge"}`;
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
    caps: { kinds: ["fact"], layers: ["project"], writable: true, search: ["lexical"], bundle: true }, trainedFor: null,
  };
  return {
    describe: () => structuredClone(descriptor),
    // Reads need no groundray binary (D9): the CLI is for proposals, which say so when it is missing.
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
      if (t.unchecked) throw new PluginError("invalid", `brain ${brain} can't be checked at ${m.commit.slice(0, 12)}: ${t.unchecked}`);
      const dir = scope.bundleRoot ? bundleDir(scope.bundleRoot, GROUNDRAY, brain) : null;
      const h: Handle = { name: brain, remote: m.repo, commit: t.commit, branch: m.branch, bundle: t.bundle, dir, slug: m.slug, id: m.id, runId: scope.runId, agentId: scope.agentId };
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
    /** A new draft in the brain (ADR-025 step 5): its run's proposal branch and pull request, as `by` (./groundray-write.ts). */
    async propose(handle: string, p: ContextProposal, by: Principal, c: SeamCall): Promise<ProposalReceipt> {
      aborted(c);
      const h = handleOf(handle);
      if ((p.op ?? "add") !== "add") throw new PluginError("unsupported", "a brain takes new drafts only (op add): its items are superseded, deprecated and verified by its owners, in groundray's own flow");
      if (!h.runId || !h.agentId) throw new PluginError("invalid", "a proposal comes from an agent of a run: resolve the brain with its scope");
      if (!h.slug || !h.id) throw new PluginError("unsupported", `brain ${h.name} has no brain.yaml: groundray authors only its own brains`);
      const draft: BrainDraft = { type: (p.type ?? "") as BrainDraft["type"], title: p.title ?? "", body: p.text.text, origin: { runId: h.runId, agentId: h.agentId } };
      const problem = draftProblem(draft);
      if (problem) throw new PluginError("invalid", `brain ${h.name} can't take this proposal: it ${problem}`);
      const w = await write({ name: h.name, repo: h.remote, branch: h.branch, slug: h.slug, id: h.id, bundle: h.bundle }, draft, actorOf(by), c);
      const where = w.pullRequest ? w.pullRequest.url ?? `pull request #${w.pullRequest.number} on ${h.remote}` : `${h.remote}, branch ${w.branch}`;
      return { id: w.itemId || `${w.branch}:${w.path}`, staged: true, where };
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
  // A path (git's rule: no `scheme://`, no `host:` before its first `/`) is kept absolute: the mapping is read by
  // processes that run elsewhere (the daemon), and git resolves a relative one against the host's mirror.
  const given = o.repo.trim();
  const repo = !/^[a-z][a-z0-9+.-]*:\/\//i.test(given) && !/^[^/]*:/.test(given) ? resolvePath(o.cwd ?? process.cwd(), given) : given;
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
  if (t.unchecked) throw new RelayError("config", `capcomd can't check that brain ${o.name} isn't restricted (${t.unchecked}), so it won't add it: its files would be copied into agents' sandboxes`, "Keep a brain to at most 2000 Markdown files of at most 4 MiB each (split a bigger one).", { code: "unchecked" });
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
