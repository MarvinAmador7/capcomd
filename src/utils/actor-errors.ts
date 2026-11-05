// What an actor action's caller learns when the action fails. rivetkit passes on only a UserError's text (rivetkit-core
// masks every other group's message, public or not); anything else, a plain Error or one of its own (a SQLite error
// such as "SQLite transaction coordinator is closed."), reached the caller as "An internal error occurred", the cause
// only in the engine's log. Every capcomd actor action goes through traceActions, which passes its errors through here.
import { UserError } from "rivetkit";
import { redactShapes } from "../agents/redact";

/** The metadata key that marks an error this module made readable: a failure, not the actor's own refusal. */
export const INTERNAL_ERROR_METADATA = "capcomdInternal";
/** The code such an error crosses with (its own group and code are in its metadata). */
export const INTERNAL_ERROR_CODE = "internal";

/**
 * The error an action throws, as its caller should see it: a refusal (a UserError) as it is; anything else as a
 * UserError with code "internal", its (redacted) message, and its own group and code in its metadata, marked internal
 * (isInternalActorError), so a caller that tells the actor's own answer from the engine failing under it
 * (src/primitives/ops.ts engineOutage, the reviewer gate) still can.
 */
export function readableActorError(e: unknown): unknown {
  if (e instanceof UserError) return e;
  const x = e as { group?: unknown; code?: unknown; message?: unknown } | null;
  if (x?.group === "user") return e;
  const message = redactShapes(String(x?.message ?? e)).slice(0, 2000) || "the action failed";
  const group = typeof x?.group === "string" ? x.group : "capcomd";
  const code = typeof x?.code === "string" && x.code ? x.code : "internal";
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
