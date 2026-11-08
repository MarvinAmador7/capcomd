// Test plugin (tests/plugins/services.test.ts, tests/scenarios/plugin-services.test.ts): the kernel's primitives as a
// plugin calls them (§8.1). Loaded in a test's own host, it hands the test its context (`probe.ctx`) and records the
// principal run.creating and profile.resolved name (`probe.heard`). Loaded in a daemon (CAPCOMD_TEST_PLUGINS), when an
// agent whose task asks for [plugin-services] names its tab it sends that agent a message, and when the agent has ended
// it reads the kv key `reply` the agent wrote, appending what each call answered to the file CAPCOMD_TEST_SERVICES_LOG
// names. It allows everything (no patch).
import { appendFileSync } from "node:fs";
import type { PluginContext } from "../../../../packages/plugin/src/context";
import { definePlugin } from "../../../../packages/plugin/src/index";

export const probe: { ctx: PluginContext | null; heard: Array<{ hook: string; principal: unknown }> } = { ctx: null, heard: [] };

export const plugin = definePlugin({
  activate(ctx) {
    probe.ctx = ctx;
    const file = process.env.CAPCOMD_TEST_SERVICES_LOG;
    const log = (x: Record<string, unknown>) => { if (file) appendFileSync(file, `${JSON.stringify(x)}\n`); };
    const failed = (what: string) => (e: unknown) => log({ what, error: (e as { code?: string })?.code ?? null, message: String((e as Error)?.message ?? e) });
    ctx.hooks.on("run.creating", (call) => { probe.heard.push({ hook: call.hook, principal: call.principal }); return { decision: "allow" }; });
    ctx.hooks.on("profile.resolved", (call) => { probe.heard.push({ hook: call.hook, principal: call.principal }); return { decision: "allow" }; });
    const asked = new Set<string>();
    ctx.hooks.on("agent.changed", ({ payload: { agent, change } }) => {
      if (!agent.task?.includes("[plugin-services]")) return;
      // Not awaited: an observe call has 5 s.
      if (change.kind === "titled" && !asked.has(agent.id)) {
        asked.add(agent.id);
        void ctx.messages.send(agent.runId, { to: agent.id, body: "ping from the services probe" }, { key: `ping-${agent.id}` })
          .then((r) => log({ what: "sent", seq: r.seq }), failed("sent"));
      }
      if (change.kind === "ended")
        void ctx.kv.get(agent.runId, "reply").then((value) => log({ what: "read", status: change.status, value }), failed("read"));
    });
  },
});
