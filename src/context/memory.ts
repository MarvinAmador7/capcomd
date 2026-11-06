// The project layer's provider (ADR-025 §3.3, §11.1; the `context-memory` built-in, src/plugins/context-memory.ts):
// the Markdown items under `.capcomd/context/` in the run's repository, read at the tip of the branch the agent starts
// from. `memory/<slug>.md` are memories (lessons, feedback, references), `facts/…` a project's own small fact bundle;
// each has OKF frontmatter (`id`, `type`, `title`/`description`, `status`, `generated`, `stale_after`, `supersedes`,
// `superseded_by`, `paths`) over its body. Read-only in this step: capture, lint and promotion arrive with ADR-025
// steps 2-3. Everything in a file is the repository's, so untrusted: the router fences what reaches the brief, and a
// body is never in it.
import { PluginError } from "../../packages/plugin/src/errors";
import type { ErrorClass, SeamCall } from "../../packages/plugin/src/seams";
import type { Authority, ContextDescriptor, ContextHit, ContextItem, ContextKind, ContextLayer, ContextProvider, ContextRef, ContextScope, ContextSearch, IndexLine } from "../../packages/plugin/src/context-layer";
/** A remote that didn't answer (the git forge's words, src/plugins/forges/git.ts). */
const NETWORK = /could not resolve host|connection (?:timed out|refused|reset)|timed out|unable to access|early eof/i;

/** Where a repository keeps its context (ADR-025 §3.3). */
export const CONTEXT_DIR = ".capcomd/context/";
/** What a provider reads of one repository at most: files, and bytes per file (a bigger one is left out). */
export const MEMORY_MAX_FILES = 2000, MEMORY_MAX_BYTES = 64 * 1024;

/** A repository's `.capcomd/context/` at a branch's tip or a commit (src/api/run-files.ts FilesMirror.readTree). */
export type TreeReader = (o: { remote: string; at: { branch: string } | { sha: string }; runId: string | null }) =>
  Promise<{ sha: string; date: string; files: Array<{ path: string; text: string | null }>; truncated: boolean } | { error: string }>;

/** The kernel's reader: the run's repository through the daemon host's files mirror, by its URL (src/merge/host-git.ts
 *  is the only network git; the mirror fetches through it). */
export const mirrorReader: TreeReader = async ({ remote, at, runId }) => {
  const { runEnv } = await import("../merge/run-config");
  const { loadMergeConfig } = await import("../merge/config");
  const cfg = loadMergeConfig({ ...(await runEnv(runId ?? undefined)), CAPCOMD_REPO: remote });
  if (!cfg) return { error: "no repository" };
  const { mirrorFor } = await import("../api/run-files");
  return mirrorFor({ remote, target: cfg.target, workdir: cfg.workdir }).readTree(at, CONTEXT_DIR, { maxFiles: MEMORY_MAX_FILES, maxBytes: MEMORY_MAX_BYTES });
};

interface Item { line: IndexLine; title: string; body: string; layer: ContextLayer; authority: Authority; by: string; method: string; at: string }
interface Parsed { revision: string; modified: string | null; items: Item[] }
interface Handle { remote: string; sha: string; project: boolean; projectId: string | null }

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : typeof v === "string" && v.trim() ? [v.trim()] : []);
/** An instant from frontmatter (YAML may have parsed a date already), as ISO, or undefined. */
const instant = (v: unknown): string | undefined => {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
};
const STATUS = new Set(["draft", "stable", "deprecated"]);
const METHODS = new Set(["human-authored", "imported", "transformed", "agent-generated", "calculated"]);

/** `---\n<yaml>\n---\n<body>`: the frontmatter as a map (empty when there is none or it doesn't parse) and the body. */
export function frontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: unknown = null;
  // Loaded on first use: every process loads this provider, few read an item.
  const { parse } = require("yaml") as typeof import("yaml");
  try { meta = parse(m[1]!, { maxAliasCount: 10, prettyErrors: false }); } catch { /* not YAML: no frontmatter */ }
  return { meta: isMap(meta) ? meta : {}, body: text.slice(m[0].length) };
}

/** The items of one tree: `memory/**.md` and `facts/**.md` (not `index.md` or `log.md`, OKF's reserved files), each id
 *  once (the first by path), supersession made reciprocal so the router can follow `supersededBy` to the head. */
export function parseItems(files: Array<{ path: string; text: string | null }>, o: { revision: string; date: string }): Parsed {
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (f.text === null || !f.path.startsWith(CONTEXT_DIR) || !f.path.endsWith(".md")) continue;
    const rel = f.path.slice(CONTEXT_DIR.length);
    const kind: ContextKind | null = rel.startsWith("memory/") ? "memory" : rel.startsWith("facts/") ? "fact" : null;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (!kind || base === "index.md" || base === "log.md") continue;
    const { meta, body } = frontmatter(f.text);
    const slug = rel.slice(rel.indexOf("/") + 1, -".md".length);
    const id = str(meta.id) ?? slug;
    if (seen.has(id)) continue;
    seen.add(id);
    const generated = isMap(meta.generated) ? meta.generated : {};
    const at = instant(meta.modified) ?? instant(meta.updated) ?? instant(generated.at) ?? instant(meta.valid_from) ?? o.date;
    const status = (STATUS.has(String(meta.status)) ? meta.status : "draft") as Authority["status"];
    const staleAfter = instant(meta.stale_after);
    const supersedes = strs(meta.supersedes), supersededBy = strs(meta.superseded_by);
    const title = str(meta.title) ?? id;
    const triggers = isMap(meta.triggers) ? meta.triggers : {};
    const paths = [...strs(meta.paths), ...strs(triggers.paths)];
    const type = str(meta.type) ?? (kind === "memory" ? "lesson" : "fact");
    const by = str(generated.by) ?? "unknown";
    items.push({
      title, body, layer: "project", by, method: METHODS.has(String(generated.method)) ? String(generated.method) : "human-authored", at,
      authority: { status, verified: [], ...(staleAfter ? { staleAfter } : {}), ...(instant(meta.valid_from) ? { validFrom: instant(meta.valid_from)! } : {}), ...(supersedes.length ? { supersedes } : {}), ...(supersededBy.length ? { supersededBy } : {}) },
      line: {
        ref: { provider: "memory", id, version: o.revision }, kind, type,
        description: { text: str(meta.description) ?? title, untrusted: true, by: "context:memory" },
        path: f.path, ...(paths.length ? { paths } : {}),
        authority: { status, ...(staleAfter ? { staleAfter } : {}), ...(supersededBy.length ? { supersededBy } : {}) },
        modified: at,
      },
    });
  }
  // `A supersedes B` without B saying so: B is superseded all the same.
  const byId = new Map(items.map((i) => [i.line.ref.id, i]));
  for (const i of items) for (const old of i.authority.supersedes ?? []) {
    const o2 = byId.get(old);
    if (!o2) continue;
    const next = [...new Set([...(o2.line.authority.supersededBy ?? []), i.line.ref.id])];
    o2.line = { ...o2.line, authority: { ...o2.line.authority, supersededBy: next } };
    o2.authority = { ...o2.authority, supersededBy: next };
  }
  const modified = items.reduce<string | null>((m, i) => (m === null || i.line.modified > m ? i.line.modified : m), null);
  return { revision: o.revision, modified, items };
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
const aborted = (c: SeamCall) => { if (c.signal.aborted) throw new PluginError("timeout", "the call was cancelled"); };

/** `context:memory` (ADR-025 §11.1). `read`: how a tree is read (the files mirror; a test's fixture). */
export function memoryProvider(o: { read?: TreeReader } = {}): ContextProvider {
  const read = o.read ?? mirrorReader;
  const cache = new Map<string, Parsed>();
  const handleOf = (h: string): Handle => {
    try { const v = JSON.parse(h) as Handle; if (typeof v.remote === "string" && typeof v.sha === "string") return v; } catch { /* below */ }
    throw new PluginError("invalid", "not a handle this provider made");
  };
  const parsed = async (h: Handle, runId: string | null): Promise<Parsed> => {
    const key = `${h.remote}\0${h.sha}`;
    const had = cache.get(key);
    if (had) return had;
    const t = await read({ remote: h.remote, at: { sha: h.sha }, runId });
    if ("error" in t) throw new PluginError("unavailable", t.error);
    const p = parseItems(t.files, { revision: t.sha, date: t.date });
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, p);
    return p;
  };
  const items = async (handle: string, c: SeamCall) => { aborted(c); const h = handleOf(handle); return h.project ? (await parsed(h, null)).items : []; };
  const descriptor: ContextDescriptor = {
    name: "memory", descriptorVersion: 1, label: "Project memory", vendor: "capcomd",
    caps: { kinds: ["memory", "fact"], layers: ["project"], writable: false, search: ["lexical"], bundle: false }, trainedFor: null,
  };
  return {
    describe: () => structuredClone(descriptor),
    async available() { return { ok: true }; },
    classifyError(e: unknown): ErrorClass {
      if (e instanceof PluginError) {
        if (e.code === "timeout") return { kind: "timeout", retryable: true };
        if (e.code === "not_found") return { kind: "not_found", retryable: false };
        if (e.code === "unavailable") return { kind: "transient", retryable: true };
        if (e.code === "invalid" || e.code === "unsupported") return { kind: "config", retryable: false, hint: e.hint ?? e.message };
      }
      return NETWORK.test(String((e as Error)?.message ?? e)) ? { kind: "transient", retryable: true } : { kind: "unknown", retryable: false };
    },
    async resolve(scope: ContextScope, c: SeamCall) {
      aborted(c);
      if (!scope.repo || !scope.ref) throw new PluginError("not_found", "the run has no repository, so no project memory");
      const t = await read({ remote: scope.repo, at: { branch: scope.ref }, runId: scope.runId });
      aborted(c);
      if ("error" in t) throw new PluginError("unavailable", t.error);
      const h: Handle = { remote: scope.repo, sha: t.sha, project: scope.layers.includes("project"), projectId: scope.projectId };
      const key = `${h.remote}\0${h.sha}`;
      if (!cache.has(key)) { if (cache.size >= 32) cache.delete(cache.keys().next().value!); cache.set(key, parseItems(t.files, { revision: t.sha, date: t.date })); }
      return { handle: JSON.stringify(h), revision: t.sha };
    },
    async index(handle: string, c: SeamCall) {
      aborted(c);
      const h = handleOf(handle);
      if (!h.project) return { revision: h.sha, modified: null, lines: [] };
      const p = await parsed(h, null);
      return { revision: p.revision, modified: p.modified, lines: p.items.map((i) => structuredClone(i.line)) };
    },
    async search(handle: string, q: ContextSearch, c: SeamCall): Promise<ContextHit[]> {
      const want = new Set(words(q.text));
      const scored = (await items(handle, c))
        .filter((i) => (!q.kinds || q.kinds.includes(i.line.kind)) && (!q.status || q.status.includes(i.authority.status)))
        .map((i) => {
          const have = words(`${i.title} ${i.line.description.text} ${i.body}`);
          return { i, score: want.size ? have.filter((w) => want.has(w)).length / Math.sqrt(have.length || 1) : 0 };
        })
        .filter((x) => x.score > 0 || !want.size)
        .sort((a, b) => b.score - a.score || (a.i.line.ref.id < b.i.line.ref.id ? -1 : 1));
      return scored.slice(0, Math.max(0, q.limit)).map(({ i, score }) => ({ ref: i.line.ref, score, title: i.title, description: i.line.description, kind: i.line.kind, authority: i.line.authority }));
    },
    async get(handle: string, ref: ContextRef, c: SeamCall): Promise<ContextItem> {
      const h = handleOf(handle);
      const i = (await items(handle, c)).find((x) => x.line.ref.id === ref.id);
      if (!i || ref.provider !== "memory") throw new PluginError("not_found", `no item ${ref.id} at ${h.sha.slice(0, 12)}`);
      return {
        ref: i.line.ref, kind: i.line.kind, type: i.line.type, title: i.title, text: { text: i.body, untrusted: true, by: "context:memory" },
        path: i.line.path, layer: i.layer, scope: { projectId: h.projectId },
        provenance: { method: i.method as ContextItem["provenance"]["method"], by: i.by, at: i.at, sources: [] }, authority: i.authority,
        citation: `[${i.title} — memory@${h.sha.slice(0, 12)}:${i.line.path} (${i.line.ref.id})]`,
      };
    },
    async propose() {
      throw new PluginError("unsupported", "project memory is read-only for now: it changes through a reviewed commit to .capcomd/context/");
    },
  };
}
