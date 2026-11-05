// The one pattern for harness.v1 event types (docs/spec/plugin-api.md §4.2, §13). Everything that names, checks or
// documents an event type uses these: the envelope schema (src/api/envelope.ts, and so openapi/capcomd.json and
// docs/events.md), the manifest's plugin name and `contributes.events` (manifest.ts, and so
// schema/plugin-manifest.schema.json), and `ctx.events.emit` (host/context.ts). A name the manifest allows always makes
// a type the envelope allows; tests/plugins/event-type.test.ts holds every kernel type to it.

/** A plugin's name: lowercase letters, digits and hyphens, 1-63 characters (kebab-case, `gate-reviewer`). */
const NAME = "[a-z0-9][a-z0-9-]{0,62}";
/** One dotted part of an event type: a lowercase word, `_` between words (`approval_requested`). */
const PART = "[a-z][a-z0-9_]*";

export const PLUGIN_NAME_PATTERN = `^${NAME}$`;
/** A plugin's own event name, without the prefix: what `contributes.events` lists and `ctx.events.emit` takes. */
export const EVENT_NAME_PATTERN = `^${PART}$`;
/**
 * Every harness.v1 event type, kernel and plugin:
 *  - the kernel's: dotted lowercase parts, `noun.verb_past` (`run.created`, `merge.approval_requested`), never under
 *    `plugin.` except its own two-part events about plugins (`plugin.loaded`, `plugin.gate_denied`);
 *  - a plugin's own: `plugin.<name>.<event>` (`plugin.gate-reviewer.verdict`), three parts, written only by that plugin.
 * So the type alone says who wrote an event. Past tense is the kernel's naming rule for its own types (decision 9), not
 * part of the pattern: two released types are nouns (agent.step, sandbox.resource_action).
 */
export const EVENT_TYPE_PATTERN = `^(?:plugin\\.(?:${NAME}\\.)?${PART}|(?!plugin\\.)${PART}(?:\\.${PART})+)$`;
export const EVENT_TYPE_DOC = "Dotted lowercase: the kernel's are noun.verb_past (run.created, merge.approval_requested); a plugin's own are plugin.<plugin name>.<event> (plugin.gate-reviewer.verdict), written only by that plugin. Show a type you don't know by its envelope text";

const TYPE = new RegExp(EVENT_TYPE_PATTERN);
const PLUGIN_NAME = new RegExp(PLUGIN_NAME_PATTERN);
const EVENT_NAME = new RegExp(EVENT_NAME_PATTERN);

export const isEventType = (type: string): boolean => TYPE.test(type);

/** `plugin.<plugin>.<event>`, refused (throws) when either part doesn't fit, so a built type always matches. */
export function pluginEventType(plugin: string, event: string): string {
  if (!PLUGIN_NAME.test(plugin)) throw new Error(`not a plugin name: ${plugin}`);
  if (!EVENT_NAME.test(event)) throw new Error(`not an event name: ${event} (lowercase words joined by _, starting with a letter)`);
  return `plugin.${plugin}.${event}`;
}

/** Who writes an event of this type: a plugin (its own `plugin.<name>.<event>`), the kernel, or null for no type. */
export function eventTypeOwner(type: string): { kind: "kernel" } | { kind: "plugin"; plugin: string; event: string } | null {
  if (!TYPE.test(type)) return null;
  const parts = type.split(".");
  return parts[0] === "plugin" && parts.length === 3 ? { kind: "plugin", plugin: parts[1]!, event: parts[2]! } : { kind: "kernel" };
}
