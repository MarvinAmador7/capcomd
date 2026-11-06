// The context provider conformance suite (ADR-025 §3.1, spec §14.2's style): what every provider of the `context`
// contribution must do, as cases a runner can report one by one. The cases that read items need a scope the provider can
// resolve (a fixture repository a test brings); without one they are skipped, as `capcomd plugins validate
// --conformance` runs them. `testkit.conformance.context` registers them as bun tests.
import { PluginError } from "./errors";
import { CONTEXT_KINDS, CONTEXT_LAYERS, type ContextProvider, type ContextScope } from "./context-layer";
import { conformanceCall, type ConformanceResult } from "./conformance";

export interface ContextConformanceOptions {
  /** The provider's declared name (`contributes.context[].name`): `describe().name` must equal it. */
  name?: string;
  /** A scope the provider can resolve, with at least one item behind it; the item cases are skipped without one. */
  scope?: ContextScope;
}

interface Case { name: string; needsScope?: true; run(p: ContextProvider, o: ContextConformanceOptions): Promise<void> }

const fail = (message: string): never => { throw new Error(message); };
const equal = (a: unknown, b: unknown, what: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const STATUS = ["draft", "stable", "deprecated"];
const ERROR_KINDS = ["config", "auth", "not_found", "transient", "quota", "timeout", "unknown"];
const isUntrusted = (v: unknown) => !!v && typeof v === "object" && (v as { untrusted?: unknown }).untrusted === true && typeof (v as { text?: unknown }).text === "string" && typeof (v as { by?: unknown }).by === "string";
const scopeOf = (o: ContextConformanceOptions) => o.scope ?? fail("no scope");

export const CONTEXT_CASES: readonly Case[] = [
  { name: "describe: descriptor version 1, its declared name, kinds and layers the kernel knows, the same each time", async run(p, o) {
    const d = p.describe();
    equal(d.descriptorVersion, 1, "descriptorVersion");
    if (o.name !== undefined) equal(d.name, o.name, "describe().name");
    if (!d.caps.kinds.length || d.caps.kinds.some((k) => !CONTEXT_KINDS.includes(k))) fail(`caps.kinds ${JSON.stringify(d.caps.kinds)}: fact and/or memory`);
    if (d.caps.layers.some((l) => !CONTEXT_LAYERS.includes(l))) fail(`caps.layers ${JSON.stringify(d.caps.layers)}: run and/or project (ADR-025 §4)`);
    equal(p.describe(), d, "a second describe()");
  } },
  { name: "available never rejects", async run(p) {
    const r = await p.available(conformanceCall(30_000)).catch((e: unknown) => fail(`available rejected: ${(e as Error)?.message ?? e}`));
    if (r.ok !== true && !(r.ok === false && typeof r.reason === "string")) fail(`available answered ${JSON.stringify(r)}`);
  } },
  { name: "classifyError classifies anything, and its own not_found as not_found", async run(p) {
    for (const e of [new Error("boom"), "a string", null, new PluginError("not_found", "no such item")]) {
      const c = p.classifyError(e);
      if (!ERROR_KINDS.includes(c.kind) || typeof c.retryable !== "boolean") fail(`classifyError(${String(e)}) answered ${JSON.stringify(c)}`);
    }
    equal(p.classifyError(new PluginError("not_found", "no such item")).kind, "not_found", "classifyError(not_found)");
  } },
  { name: "propose is refused unless the provider is writable", async run(p) {
    if (p.describe().caps.writable) return;
    const e = await p.propose("conformance", { text: { text: "a lesson", untrusted: true, by: "agt-conformance" } }, { kind: "operator", clientId: null }, conformanceCall()).then(() => null, (x: unknown) => x);
    if (!(e instanceof PluginError && e.code === "unsupported")) fail(`propose on a read-only provider must reject unsupported, got ${e === null ? "a receipt" : String((e as Error)?.message ?? e)}`);
  } },
  { name: "a call whose signal is already aborted rejects", async run(p, o) {
    const c = conformanceCall();
    const ac = new AbortController();
    ac.abort(new PluginError("timeout", "conformance"));
    const e = await p.resolve(o.scope ?? { projectId: null, repo: null, ref: null, profile: { name: "conformance", version: 1 }, runId: null, agentId: null, layers: ["project"] }, { ...c, signal: ac.signal }).then(() => null, (x: unknown) => x);
    if (e === null) fail("resolve resolved with an aborted signal: it must reject (spec §7.1's rule for every SeamCall)");
  } },
  { name: "resolve binds a scope to the same handle and revision each time", needsScope: true, async run(p, o) {
    const a = await p.resolve(scopeOf(o), conformanceCall()), b = await p.resolve(scopeOf(o), conformanceCall());
    if (typeof a.handle !== "string" || !a.handle || typeof a.revision !== "string" || !a.revision) fail(`resolve answered ${JSON.stringify(a)}`);
    equal(b, a, "a second resolve of the same scope");
  } },
  { name: "index is deterministic for a handle, at the revision resolve named, every line well-formed", needsScope: true, async run(p, o) {
    const d = p.describe();
    const r = await p.resolve(scopeOf(o), conformanceCall());
    const a = await p.index(r.handle, conformanceCall()), b = await p.index(r.handle, conformanceCall());
    equal(b, a, "a second index of the same handle");
    equal(a.revision, r.revision, "index().revision");
    if (!a.lines.length) fail("the fixture scope has no items: bring one with at least one");
    for (const l of a.lines) {
      const at = `line ${JSON.stringify(l.ref?.id)}`;
      if (l.ref?.provider !== d.name || typeof l.ref.id !== "string" || !l.ref.id || typeof l.ref.version !== "string") fail(`${at}: ref is {provider: ${d.name}, id, version}`);
      if (!d.caps.kinds.includes(l.kind)) fail(`${at}: kind ${l.kind} isn't one of caps.kinds`);
      if (typeof l.type !== "string" || !l.type) fail(`${at}: type is a non-empty string`);
      if (!isUntrusted(l.description)) fail(`${at}: description is untrusted text {text, untrusted: true, by}`);
      if (typeof l.path !== "string" || !l.path) fail(`${at}: path is where the body is`);
      if (!STATUS.includes(l.authority?.status)) fail(`${at}: authority.status is draft, stable or deprecated`);
      if (l.paths !== undefined && !(Array.isArray(l.paths) && l.paths.every((x) => typeof x === "string"))) fail(`${at}: paths is a list of strings`);
      if (typeof l.modified !== "string") fail(`${at}: modified is a string`);
    }
  } },
  { name: "get returns an indexed item, its text untrusted", needsScope: true, async run(p, o) {
    const r = await p.resolve(scopeOf(o), conformanceCall());
    const line = (await p.index(r.handle, conformanceCall())).lines[0] ?? fail("no items");
    const item = await p.get(r.handle, line.ref, conformanceCall());
    equal(item.ref, line.ref, "get().ref");
    if (!isUntrusted(item.text)) fail("get().text is untrusted text");
    if (!CONTEXT_LAYERS.includes(item.layer)) fail(`get().layer ${item.layer}`);
    const missing = await p.get(r.handle, { ...line.ref, id: `${line.ref.id}-conformance-missing` }, conformanceCall()).then(() => null, (e: unknown) => e);
    if (missing === null || p.classifyError(missing).kind !== "not_found") fail("get of an id that isn't there must reject not_found");
  } },
  { name: "search answers at most `limit` hits, their descriptions untrusted", needsScope: true, async run(p, o) {
    const r = await p.resolve(scopeOf(o), conformanceCall());
    const hits = await p.search(r.handle, { text: "the", limit: 1 }, conformanceCall());
    if (!Array.isArray(hits) || hits.length > 1) fail(`search with limit 1 answered ${Array.isArray(hits) ? hits.length : "no list"}`);
    for (const h of hits) if (!isUntrusted(h.description) || typeof h.score !== "number") fail(`hit ${JSON.stringify(h.ref)}: a score and untrusted description`);
  } },
];

/** The cases for `p`, those that read items skipped without a scope. */
export function contextCases(p: ContextProvider, opts: ContextConformanceOptions = {}): Array<{ name: string; skip: boolean; run(): Promise<void> }> {
  return CONTEXT_CASES.map((c) => ({ name: c.name, skip: !!c.needsScope && !opts.scope, run: () => c.run(p, opts) }));
}

/** Run the whole suite against `p` and report every case (`capcomd plugins validate --conformance`). */
export async function runContextConformance(p: ContextProvider, opts: ContextConformanceOptions = {}): Promise<ConformanceResult[]> {
  const out: ConformanceResult[] = [];
  for (const c of contextCases(p, opts)) {
    if (c.skip) { out.push({ name: c.name, ok: true, skipped: true, ms: 0, message: "needs a scope with items (a fixture repository)" }); continue; }
    const t0 = Date.now();
    try { await c.run(); out.push({ name: c.name, ok: true, skipped: false, ms: Date.now() - t0, message: null }); } catch (e) {
      out.push({ name: c.name, ok: false, skipped: false, ms: Date.now() - t0, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
