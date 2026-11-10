// The plugin manifest (`plugin.json`), spec §4. This zod schema is the one source: the TypeScript type is inferred
// from it and schema/plugin-manifest.schema.json is generated from it (scripts/schema.ts; the test fails when stale).
import { z } from "zod";
import { EVENT_NAME_PATTERN, PLUGIN_NAME_PATTERN } from "./event-type";

/** `^[a-z0-9][a-z0-9-]{0,62}$`: the name every contribution of the plugin is namespaced by (§4.2). It is one part of
 *  the event type pattern (event-type.ts), so every name allowed here makes valid `plugin.<name>.<event>` types. */
export { PLUGIN_NAME_PATTERN };
export const PluginName = z.string().regex(new RegExp(PLUGIN_NAME_PATTERN)).describe("Plugin name: lowercase letters, digits and hyphens, 1-63 characters. Every contribution is namespaced by it");

/** A semver version (no range). */
export const SEMVER_PATTERN = "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$";
export const Semver = z.string().regex(new RegExp(SEMVER_PATTERN)).describe("Semantic version, e.g. 1.2.0 or 1.2.0-rc.1");

export const MANIFEST_SCHEMA_ID = "capcomd.plugin/v1" as const;

/** The hooks a plugin may listen to (§6). Mirrors `HOOK_NAMES` in hooks.ts; the test asserts the two agree. */
export const MANIFEST_HOOK_NAMES = [
  "daemon.started", "daemon.stopping",
  "run.creating", "run.changed",
  "profile.resolved",
  "agent.spawning", "agent.preparing", "agent.changed", "agent.item",
  "sandbox.ensuring", "sandbox.changed",
  "verify.starting", "verify.judging", "verify.changed",
  "merge.landing", "merge.changed",
  "approval.deciding", "approval.changed",
  "job.changed",
  "trigger.admitting", "trigger.changed",
] as const;
export const HookNameSchema = z.enum(MANIFEST_HOOK_NAMES);

/** The kinds of a `job.changed` call's `change` (§6.6.19). Mirrors `JobChange` in hooks.ts; the test asserts the two agree. */
export const JOB_CHANGE_KINDS = ["started", "output", "fired", "ended"] as const;

/** harness.v1 token scopes a plugin's principal may hold (§11.1). `approve` is never grantable to a plugin. */
export const PLUGIN_SCOPES = ["read", "steer", "configure"] as const;
export const PluginScope = z.enum(PLUGIN_SCOPES);

/** What a plugin provides or requires: a capability id (§4.6). */
export const CAPABILITY_ID_PATTERN = "^(seam:(sandbox|agent|forge)/[a-z0-9][a-z0-9-]{0,62}|source:[a-z0-9][a-z0-9-]{0,62}|context:[a-z0-9][a-z0-9_-]{0,62}|plugin:[a-z0-9][a-z0-9-]{0,62}|kernel:[a-z][a-z0-9_.-]*)$";
export const CapabilityId = z.string().regex(new RegExp(CAPABILITY_ID_PATTERN))
  .describe("seam:sandbox/<name>, seam:agent/<name>, seam:forge/<name> (an implementation of a seam under that name), source:<name> (a trigger source, §16.3), context:<name> (a context provider a profile names, ADR-025 §3.1), plugin:<name> (another plugin, active), or kernel:<feature> (a kernel feature by its harness.v1 capability name)");

/** One hook listener declared in the manifest (§4.7). The code must register exactly the hooks declared here. */
export const HookDeclaration = z.object({
  timeoutMs: z.number().int().min(100).optional().describe("The listener's deadline. May lower the hook's default; may never exceed the hook's maximum (§6.4). Default: the hook's default"),
  failure: z.enum(["closed", "open"]).optional().describe("What a timeout, throw, crash or invalid result means: closed denies the operation (naming this plugin), open skips this listener. Gate hooks are always closed (declaring open is a validation error); other veto/modify hooks default to open; observe hooks are always open"),
  changes: z.array(z.enum(JOB_CHANGE_KINDS)).min(1).optional().describe("job.changed only: the change kinds this listener is called for (§6.6.19). Default: every kind. A plugin that only keeps a timer declares [\"fired\"], and the kernel then reads no running job's output for it"),
}).strict();

export const CliCommandContribution = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("The command group's first word, e.g. `slack`. Must not collide with a kernel command (§4.7.1)"),
  summary: z.string().min(1).max(120),
}).strict();

export const McpToolContribution = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/).describe("Tool name without the prefix: registered as `capcomd_<plugin>_<name>` (§4.7.2)"),
  summary: z.string().min(1).max(200),
}).strict();

export const ApiRouteContribution = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().regex(/^\/[a-z0-9{}/_.-]*$/).describe("Relative to `/v1/x/<plugin>` (§4.7.3), e.g. `/digest`"),
  scope: PluginScope.describe("The caller's scope the route needs (not the plugin's)"),
}).strict();

/** A route path's `{name}` segment: it takes any one path segment (§4.7.3); any other segment is literal. */
const routeParam = (segment: string): boolean => /^\{[^{}]+\}$/.test(segment);

/** A path both route patterns match, when they would tie at the gateway: the same number of `{param}` segments (the
 *  route with fewer wins otherwise, §4.7.3) and every segment a parameter in one of them or the same literal in both.
 *  null when no path ties them. `/a/{x}/c` and `/a/b/{y}` tie on `/a/b/c`. */
export function ambiguousRoutes(a: string, b: string): string | null {
  const as = a.split("/"), bs = b.split("/");
  if (as.length !== bs.length || as.filter(routeParam).length !== bs.filter(routeParam).length) return null;
  const path: string[] = [];
  for (const [i, x] of as.entries()) {
    const y = bs[i]!;
    if (routeParam(x) && routeParam(y)) path.push("x");
    // A parameter never takes an empty segment, so it can't meet an empty literal (`/a//b`).
    else if (routeParam(x)) { if (!y) return null; path.push(y); }
    else if (routeParam(y)) { if (!x) return null; path.push(x); }
    else if (x === y) path.push(x);
    else return null;
  }
  return path.join("/");
}

export const UiSurfaceContribution = z.object({
  kind: z.enum(["settings", "info", "action", "card", "profile-field"]).describe("Descriptor kinds the app renders generically (§4.7.5; ADR-021's settings rows generalised)"),
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
}).strict();

export const SeamKind = z.enum(["sandbox", "agent", "forge"]);
export const SeamContribution = z.object({
  kind: SeamKind,
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe("The implementation's name: what a run's `sandbox`, a profile's `harness.provider` or a repository's `merge.forge` selects (§7)"),
}).strict();

export const SourceContribution = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe("The source's name (`github`, `slack`): what `ctx.triggers.emit` must name and what `triggers.sources.<name>` in config keys (§16.3)"),
  summary: z.string().min(1).max(200),
}).strict();

/** A context provider (ADR-025 §3.1): what a profile's `context.providers[].name` selects. Named like a profile, since
 *  a profile names it. */
export const ContextContribution = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).describe("The provider's name: what a profile's `context.providers[].name` selects (`memory`, `groundray`)"),
  kinds: z.array(z.enum(["fact", "memory"])).min(1).describe("The kinds of item it serves: fact (owned, sourced business knowledge) and memory (lessons a project learned)"),
}).strict();

/** Declarative contributions: scanned at `validated`, before any code runs (§4.7). The code may register only these. */
export const Contributions = z.object({
  hooks: z.partialRecord(HookNameSchema, HookDeclaration).optional().describe("Hook listeners by hook name (§6). One listener per hook per plugin"),
  seams: z.array(SeamContribution).max(3).optional().describe("Seam implementations (§7). At most one per kind"),
  sources: z.array(SourceContribution).optional().describe("Trigger sources this plugin feeds (§16.3); each must be listed in provides as source:<name>"),
  context: z.array(ContextContribution).optional().describe("Context providers (ADR-025 §3.1); each must be listed in provides as context:<name>"),
  cli: z.array(CliCommandContribution).optional(),
  mcp: z.array(McpToolContribution).optional(),
  api: z.array(ApiRouteContribution).optional(),
  ui: z.array(UiSurfaceContribution).optional(),
  events: z.array(z.string().regex(new RegExp(EVENT_NAME_PATTERN))).optional().describe("Event types the plugin emits, without the prefix: emitted as `plugin.<name>.<type>` (§4.7.4). Lowercase words joined by _, starting with a letter (`verdict`, `thread_posted`), so `plugin.<name>.<type>` is a valid event type"),
}).strict();

export const InProcessEntry = z.object({
  runtime: z.literal("in-process"),
  module: z.string().regex(/^\.\/[^\0]+\.(js|mjs|ts)$/).describe("A module path relative to the manifest, exporting `plugin: PluginModule` (§5.1). Built-ins only (§5.2)"),
}).strict();

export const ProcessEntry = z.object({
  runtime: z.literal("process"),
  command: z.array(z.string().min(1)).min(1).describe("argv the host starts, cwd = the plugin's root. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are substituted (§9.2)"),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).optional().describe("Extra environment, added to the filtered base (§9.2). Never a secret"),
}).strict();

export const Entry = z.discriminatedUnion("runtime", [InProcessEntry, ProcessEntry]);

/** `plugins.<name>` config schema: a JSON Schema (draft 2020-12) object schema, inline or by relative `$ref` (§10.1). */
export const ConfigSchemaRef = z.object({ $ref: z.string().regex(/^\.\/[^\0]+\.json$/) }).strict();
export const ConfigSchema = z.union([ConfigSchemaRef, z.record(z.string(), z.unknown())])
  .describe("A JSON Schema (draft 2020-12) for `plugins.<name>` in config, inline or `{\"$ref\": \"./config.schema.json\"}`. Properties marked `\"x-secret\": true` take secret references, never values (§10.3). Properties marked `\"x-per-run\": true` may be overridden per run (§10.2)");

export const PluginManifest = z.object({
  schema: z.literal(MANIFEST_SCHEMA_ID).describe("The manifest schema id. A different id is refused (§12.2)"),
  name: PluginName,
  version: Semver.describe("The plugin's own version. Built-ins use the capcomd package version"),
  description: z.string().min(1).max(500),
  apiVersion: z.literal(1).describe("The plugin API major this plugin codes against (§12.1). The kernel refuses a major it doesn't serve"),
  engines: z.object({
    capcomd: z.string().min(1).describe("A semver range of capcomd versions this plugin was tested with (§4.4). `*` is refused"),
  }).strict(),
  entry: Entry,
  scopes: z.array(PluginScope).optional().describe("harness.v1 scopes the plugin's own principal holds (§11.1). Default: none (the plugin can only answer hooks). `approve` is not grantable"),
  provides: z.array(CapabilityId).optional().describe("Capabilities this plugin provides: each `seam:` entry must match a `contributes.seams` entry (§4.6)"),
  requires: z.array(CapabilityId).optional().describe("Capabilities that must be present and active before this plugin loads; a missing one fails resolution (§4.6)"),
  order: z.enum(["pre", "normal", "post"]).optional().describe("Placement among plugins (§6.3). Default normal"),
  after: z.array(PluginName).optional().describe("Plugins this one runs after, within its order (§6.3). An unknown name is ignored; a cycle fails resolution"),
  contributes: Contributions.optional(),
  config: ConfigSchema.optional(),
  homepage: z.string().url().optional(),
  license: z.string().max(100).optional(),
}).strict().superRefine((m, ctx) => {
  if (m.engines.capcomd.trim() === "*") ctx.addIssue({ code: "custom", path: ["engines", "capcomd"], message: "engines.capcomd must not be `*`: name the range you tested with" });
  const seams = m.contributes?.seams ?? [];
  const kinds = new Set<string>();
  for (const s of seams) {
    if (kinds.has(s.kind)) ctx.addIssue({ code: "custom", path: ["contributes", "seams"], message: `at most one ${s.kind} seam per plugin` });
    kinds.add(s.kind);
  }
  const provided = new Set(m.provides ?? []);
  for (const s of seams) {
    const id = `seam:${s.kind}/${s.name}`;
    if (!provided.has(id)) ctx.addIssue({ code: "custom", path: ["provides"], message: `a seam contribution must be listed in provides: ${id}` });
  }
  for (const id of provided) if (id.startsWith("seam:") && !seams.some((s) => `seam:${s.kind}/${s.name}` === id)) ctx.addIssue({ code: "custom", path: ["provides"], message: `${id} is provided but not contributed (contributes.seams)` });
  const sources = m.contributes?.sources ?? [];
  for (const s of sources) if (!provided.has(`source:${s.name}`)) ctx.addIssue({ code: "custom", path: ["provides"], message: `a source contribution must be listed in provides: source:${s.name}` });
  for (const id of provided) if (id.startsWith("source:") && !sources.some((s) => `source:${s.name}` === id)) ctx.addIssue({ code: "custom", path: ["provides"], message: `${id} is provided but not contributed (contributes.sources)` });
  const contexts = m.contributes?.context ?? [];
  const contextNames = new Set<string>();
  for (const c of contexts) {
    if (contextNames.has(c.name)) ctx.addIssue({ code: "custom", path: ["contributes", "context"], message: `the context provider ${c.name} is listed twice` });
    contextNames.add(c.name);
    if (!provided.has(`context:${c.name}`)) ctx.addIssue({ code: "custom", path: ["provides"], message: `a context contribution must be listed in provides: context:${c.name}` });
  }
  for (const id of provided) if (id.startsWith("context:") && !contextNames.has(id.slice("context:".length))) ctx.addIssue({ code: "custom", path: ["provides"], message: `${id} is provided but not contributed (contributes.context)` });
  const routes = m.contributes?.api ?? [];
  for (const [i, a] of routes.entries()) for (const b of routes.slice(i + 1)) {
    const both = a.method === b.method ? ambiguousRoutes(a.path, b.path) : null;
    if (both !== null) ctx.addIssue({ code: "custom", path: ["contributes", "api"], message: `${a.method} ${a.path} and ${b.method} ${b.path} both match ${both} with as many parameters, so neither would win: make one of them literal where the other has a parameter (§4.7.3)` });
  }
  if (provided.has(`plugin:${m.name}`)) ctx.addIssue({ code: "custom", path: ["provides"], message: "a plugin provides itself implicitly; do not list plugin:<own name>" });
  for (const id of m.requires ?? []) if (id === `plugin:${m.name}` || provided.has(id)) ctx.addIssue({ code: "custom", path: ["requires"], message: `a plugin cannot require what it provides: ${id}` });
  if (m.scopes?.includes("approve" as never)) ctx.addIssue({ code: "custom", path: ["scopes"], message: "approve is not grantable to a plugin (§11.1)" });
  for (const [hook, decl] of Object.entries(m.contributes?.hooks ?? {})) {
    const gate = /^(verify|merge|approval|trigger\.admitting)/.test(hook);
    if (gate && decl.failure === "open") ctx.addIssue({ code: "custom", path: ["contributes", "hooks", hook, "failure"], message: `${hook} is a gate hook: failure is always closed (§6.5)` });
    if (decl.changes && hook !== "job.changed") ctx.addIssue({ code: "custom", path: ["contributes", "hooks", hook, "changes"], message: `changes is for job.changed only, not ${hook} (§4.7)` });
  }
  if (m.entry.runtime === "in-process" && (m.contributes?.hooks ? Object.keys(m.contributes.hooks).length : 0) === 0 && !seams.length && !sources.length && !contexts.length && !m.contributes?.cli?.length && !m.contributes?.mcp?.length && !m.contributes?.api?.length && !m.contributes?.ui?.length && !m.contributes?.events?.length)
    ctx.addIssue({ code: "custom", path: ["contributes"], message: "a plugin must contribute something (§4.7)" });
});

export type PluginManifest = z.infer<typeof PluginManifest>;
export type PluginScope = z.infer<typeof PluginScope>;
export type CapabilityId = z.infer<typeof CapabilityId>;
export type Contributions = z.infer<typeof Contributions>;
export type HookDeclaration = z.infer<typeof HookDeclaration>;
export type SeamKind = z.infer<typeof SeamKind>;
export type ContextContribution = z.infer<typeof ContextContribution>;
export type Entry = z.infer<typeof Entry>;

/** Parse and validate a manifest; the structured issues are what `capcomd plugins validate` prints (§4.9). */
export function parseManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const r = PluginManifest.safeParse(raw);
  if (r.success) return { ok: true, manifest: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message })) };
}
