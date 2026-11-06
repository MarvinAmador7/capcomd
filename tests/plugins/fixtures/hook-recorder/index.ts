// Test plugin (tests/scenarios/hooks-order.test.ts): listens to every hook, appends one JSON line per call to the file
// CAPCOMD_TEST_HOOK_LOG names, and allows everything (no patch), so the kernel behaves as with no plugin at all.
import { appendFileSync } from "node:fs";
import { definePlugin } from "../../../../packages/plugin/src/index";
import { HOOK_NAMES, HOOKS, type HookCall, type HookName } from "../../../../packages/plugin/src/hooks";

/** What the test reads back about one call. */
export type Recorded = { hook: HookName; mode: string; at: string; key: string; runId: string | null; agentId: string | null; principal: string; change: string | null; subject: string | null; profile?: { name: string; version: number; source: string } };

function record(call: HookCall): Recorded {
  const p = call.payload as Record<string, any>;
  const subject = p.merge?.mrgId ?? p.verification?.vfyId ?? p.approval?.approvalId ?? p.agent?.id ?? p.machine?.id ?? (call.hook === "agent.spawning" ? p.spawn?.profile : null) ?? (call.hook === "profile.resolved" ? p.profile?.name : null) ?? null;
  return { hook: call.hook, mode: call.mode, at: call.at, key: call.idempotencyKey, runId: call.runId, agentId: call.agentId, principal: call.principal.kind, change: p.change?.kind ?? null, subject, ...(call.hook === "profile.resolved" ? { profile: p.profile } : {}) };
}

export const plugin = definePlugin({
  activate(ctx) {
    const file = process.env.CAPCOMD_TEST_HOOK_LOG;
    const on = ctx.hooks.on as (hook: HookName, listener: (call: HookCall) => unknown) => unknown;
    for (const hook of HOOK_NAMES) {
      on(hook, (call) => {
        if (file) appendFileSync(file, `${JSON.stringify(record(call))}\n`);
        return HOOKS[hook].mode === "observe" ? undefined : { decision: "allow" };
      });
    }
  },
});
