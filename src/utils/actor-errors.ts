// What an actor action's caller learns when the action fails. rivetkit passes on every error's group and code, but the
// text only of a UserError and of some of its own (rivetkit-core masks the rest, public or not): a plain Error, or one
// such as "SQLite transaction coordinator is closed.", reached the caller as "An internal error occurred", the cause
// only in the engine's log. Every capcomd actor action goes through traceActions, which passes its errors through here.
// rivetkit's own lifecycle errors (group "actor" or "guard": an actor stopping, starting, not found, rescheduled) are
// left as they are: its client acts on them (a call that met an actor stopping is sent again, to the actor awake).
import { UserError } from "rivetkit";
import { redactShapes } from "../agents/redact";

/** The metadata key that marks an error this module made readable: a failure, not the actor's own refusal. */
export const INTERNAL_ERROR_METADATA = "capcomdInternal";
/** The code such an error crosses with (its own group and code are in its metadata). */
export const INTERNAL_ERROR_CODE = "internal";

/** Groups rivetkit passes on as they are and its client acts on: a refusal, an actor's lifecycle, the gateway's. */
const RIVETKIT_OWN = new Set(["user", "actor", "guard"]);
/** How rivetkit's native layer hands a structured error to JavaScript: this prefix, then the error as JSON. */
const BRIDGE_PREFIX = "__RIVET_ERROR_JSON__:";

/** An error's group, code and text, with a structured error from rivetkit's native layer decoded. */
function shapeOf(e: unknown): { group?: unknown; code?: unknown; message: unknown } {
  const x = e as { group?: unknown; code?: unknown; message?: unknown } | null;
  const raw = typeof e === "string" ? e : typeof x?.message === "string" ? x.message : null;
  if (raw?.startsWith(BRIDGE_PREFIX)) {
    try {
      const j = JSON.parse(raw.slice(BRIDGE_PREFIX.length));
      if (j && typeof j.group === "string") return { group: j.group, code: j.code, message: j.message ?? raw };
    } catch {}
  }
  return { group: x?.group, code: x?.code, message: x?.message ?? e };
}

/**
 * The error an action throws, as its caller should see it: a refusal (a UserError) or one of rivetkit's lifecycle
 * errors as it is; anything else as a UserError with code "internal", its (redacted) message, and its own group and
 * code in its metadata, marked internal (isInternalActorError), so a caller that tells the actor's own answer from the
 * engine failing under it (src/primitives/ops.ts engineOutage, the reviewer gate) still can.
 */
export function readableActorError(e: unknown): unknown {
  if (e instanceof UserError) return e;
  const x = shapeOf(e);
  if (typeof x.group === "string" && RIVETKIT_OWN.has(x.group)) return e;
  const message = redactShapes(String(x.message)).slice(0, 2000) || "the action failed";
  const group = typeof x.group === "string" ? x.group : "capcomd";
  const code = typeof x.code === "string" && x.code ? x.code : "internal";
  return new UserError(message, { code: INTERNAL_ERROR_CODE, metadata: { [INTERNAL_ERROR_METADATA]: true, group, code }, cause: e });
}

/** The group and code of an action's failure made readable here (not the actor's own refusal), else null. */
export function internalActorError(e: unknown): { group: string; code: string } | null {
  const m = (e as { metadata?: unknown } | null)?.metadata as Record<string, unknown> | undefined;
  return m && typeof m === "object" && m[INTERNAL_ERROR_METADATA] === true ? { group: String(m.group ?? "capcomd"), code: String(m.code ?? "internal") } : null;
}
export const isInternalActorError = (e: unknown): boolean => internalActorError(e) !== null;

/** An action that throws only readable errors (see readableActorError). */
export function withReadableErrors<F extends (...args: any[]) => any>(fn: F): F {
  return function (this: unknown, ...args: any[]) {
    try {
      const out = fn.apply(this, args);
      return out && typeof (out as Promise<unknown>).then === "function" ? (out as Promise<unknown>).catch((e) => { throw readableActorError(e); }) : out;
    } catch (e) { throw readableActorError(e); }
  } as F;
}
