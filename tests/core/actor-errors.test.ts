// An actor action's failure now crosses with its own text (src/utils/actor-errors.ts), except rivetkit's own lifecycle
// errors, which its client acts on. That text is about what the action did, so it must not be read as the engine being
// down: the engine answered.
import { expect, test } from "bun:test";
import { toRelayError } from "../../src/core/errors";
import { RivetError, UserError } from "rivetkit";
import { readableActorError } from "../../src/utils/actor-errors";

/** As the caller receives it: rivetkit's client error carries the UserError's code and metadata. */
const crossed = (e: unknown) => {
  const u = readableActorError(e) as { message: string; code: string; metadata: unknown };
  return Object.assign(new Error(u.message), { group: "user", code: u.code, metadata: u.metadata });
};

// rivetkit's client sends a call again when it meets an actor stopping, starting or not found (group "actor") or the
// gateway's scheduling errors (group "guard"), and those cross with their group and code already: turned into a
// UserError they stopped being retried (measured on 2.3.31: an action throwing actor/stopping was sent 60 times, the
// same error made "readable" once).
test("rivetkit's own lifecycle errors are left as they are, for its client to act on", () => {
  const stopping = new RivetError("actor", "stopping", "database accessed after actor stopped");
  for (const e of [stopping, new RivetError("actor", "not_found", "The actor does not exist or was destroyed."), new RivetError("guard", "actor_ready_timeout", "x"), new UserError("no such task", { code: "not_found" })]) {
    expect(readableActorError(e)).toBe(e);
  }
  // The same, handed over by rivetkit's native layer as encoded text.
  const bridged = new Error(`__RIVET_ERROR_JSON__:${JSON.stringify({ group: "actor", code: "stopping", message: "Actor stopping" })}`);
  expect(readableActorError(bridged)).toBe(bridged);
  // A native error of another group: its own text, decoded, not the encoding.
  const sqlite = readableActorError(new Error(`__RIVET_ERROR_JSON__:${JSON.stringify({ group: "sqlite", code: "closed", message: "SQLite transaction coordinator is closed." })}`)) as UserError;
  expect([sqlite.code, sqlite.message, sqlite.metadata]).toEqual(["internal", "SQLite transaction coordinator is closed.", { capcomdInternal: true, group: "sqlite", code: "closed" }]);
  // Anything else crosses with its text, marked as the action's failure.
  const plain = readableActorError(new Error("Run run-x not found")) as UserError;
  expect([plain.group, plain.code, plain.message]).toEqual(["user", "internal", "Run run-x not found"]);
});

test("an action that failed calling something else is the action's failure, not the engine unreachable", () => {
  for (const text of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:443", "Unable to connect. Is the computer able to access the url?"]) {
    const e = toRelayError(crossed(new Error(text)));
    expect([text, e.code, e.exitCode]).toEqual([text, "run_failed", 1]);
    expect(e.message).toBe(text);
  }
  // The engine itself not answering is still engine_unreachable.
  expect(toRelayError(new Error("fetch failed")).code).toBe("engine_unreachable");
  expect(toRelayError(new Error("Unable to connect. Is the computer able to access the url?")).code).toBe("engine_unreachable");
});
