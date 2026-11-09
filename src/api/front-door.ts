// Capability ops.front_door (docs/spec/plugin-api.md §6.1, the owner's decision of 2026-11-08): a kernel front door's
// verify, merge and approval of a merge (the CLI's, `capcomd mcp`'s) run here, in the daemon, so every plugin's gate
// judges them, an out-of-process plugin's too, as it judges an agent's. Each starts the operation (or joins the one with
// its id, src/primitives/ops.ts `inflightOps`) and hands back its id and the promise of its record; the gateway
// (src/api/server.ts) waits for it a bounded time and answers 202 while it runs on. The front door's side is
// src/cli/daemon.ts `daemonOp`; with no daemon it runs them itself (src/primitives/front-door.ts).
import type { z } from "zod";
import { RelayError } from "../core/errors";
import type { FrontDecisionBody, FrontMergeBody, FrontVerifyBody } from "./contract";

/** One operation, started or joined: its id now, its record once it ends (rejected with its RelayError). */
export type FrontOp = { id: string; done: Promise<Record<string, unknown>> };

export interface FrontDoorOps {
  verify(runId: string, b: z.infer<typeof FrontVerifyBody>): Promise<FrontOp>;
  merge(runId: string, b: z.infer<typeof FrontMergeBody>): Promise<FrontOp>;
  decide(runId: string, mergeId: string, b: z.infer<typeof FrontDecisionBody>): Promise<FrontOp>;
}

/** How long a keyed decision's end is kept for its front door's next poll (that poll comes at once after a 202). */
export const DECIDED_KEPT_MS = 10 * 60_000;

/** The kernel's operations (src/primitives/ops.ts), as the CLI and `capcomd mcp` call them when they run them themselves. */
export function kernelFrontDoor(): FrontDoorOps {
  // A decision being made, by merge: the same decision asked again (a front door's next poll) joins it, so approval.deciding
  // isn't asked twice and the poll sees the merge it started; a merge is decided once (decideMerge's CAS) either way. A
  // front door's decision carries a `key` of its own: its record stays here a while after it ends, so a poll that comes
  // after the end gets that record instead of deciding again (an approval that a plugin then held would otherwise be
  // approved a second time, past the hold, with nobody asking).
  const deciding = new Map<string, Promise<Record<string, unknown>>>();
  const ops = () => import("../primitives/ops");
  return {
    async verify(runId, b) {
      const O = await ops();
      if (!b.ref && !b.id) throw new RelayError("usage", "ref or id required", "Pass the ref to verify (an agent id or a branch), or the vfy-… id of a verification to ask for.");
      const id = b.id ?? O.verifyIdFor(runId, b.ref!, b.key);
      const done = O.verifyRef({
        runId, ref: b.ref ?? "", id, ...(b.check !== undefined ? { check: b.check } : {}), ...(b.checks !== undefined ? { checks: b.checks } : {}),
        ...(b.acceptance !== undefined ? { acceptance: b.acceptance } : {}), ...(b.target !== undefined ? { target: b.target } : {}),
        ...(b.reviewProfile !== undefined ? { reviewProfile: b.reviewProfile } : {}), ...(b.key !== undefined ? { key: b.key } : {}),
      }) as Promise<Record<string, unknown>>;
      return { id, done };
    },
    async merge(runId, b) {
      const O = await ops();
      if (!b.ref && !b.id) throw new RelayError("usage", "ref or id required", "Pass the ref and require (the id of a passing verify of it), or the mrg-… id of a merge to ask for.");
      const id = b.id ?? (await O.mergeIdFor(runId, b.ref!, b.key, b.target));
      const done = O.mergeRef({
        runId, ref: b.ref ?? "", id, ...(b.require !== undefined ? { require: b.require } : {}), ...(b.target !== undefined ? { target: b.target } : {}),
        operator: b.operator === true, ...(b.requestApproval ? { requestApproval: true } : {}), ...(b.key !== undefined ? { key: b.key } : {}),
      }) as Promise<Record<string, unknown>>;
      return { id, done };
    },
    async decide(runId, mergeId, b) {
      const k = `${runId}\u0000${mergeId}\u0000${b.approve ? "approve" : "deny"}\u0000${b.key ?? ""}`;
      let done = deciding.get(k);
      if (!done) {
        const O = await ops();
        done = O.decideMerge(runId, mergeId, { approve: b.approve, by: b.by ?? "cli", ...(b.reason ? { reason: b.reason } : {}) }) as Promise<Record<string, unknown>>;
        const d = done;
        deciding.set(k, d);
        const forget = () => {
          if (!b.key) return void deciding.delete(k);
          setTimeout(() => { if (deciding.get(k) === d) deciding.delete(k); }, DECIDED_KEPT_MS).unref?.();
        };
        d.then(forget, forget);
      }
      return { id: mergeId, done };
    },
  };
}
