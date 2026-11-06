// Test plugin (tests/scenarios/jobs.test.ts): a plugin's jobs for an agent (§16.2). When an agent whose task asks for
// [plugin-jobs] names its tab, it starts a timer the agent owns (every second) and a command in the agent's machine,
// and appends what each start answered, and each job.changed of its own jobs, to the file CAPCOMD_TEST_JOB_LOG names.
import { appendFileSync } from "node:fs";
import { definePlugin } from "../../../../packages/plugin/src/index";

const started = new Set<string>();

export const plugin = definePlugin({
  activate(ctx) {
    const file = process.env.CAPCOMD_TEST_JOB_LOG;
    const log = (x: Record<string, unknown>) => { if (file) appendFileSync(file, `${JSON.stringify(x)}\n`); };
    ctx.hooks.on("agent.changed", ({ payload: { agent, change } }) => {
      if (change.kind !== "titled" || !agent.task?.includes("[plugin-jobs]") || started.has(agent.id)) return;
      started.add(agent.id);
      // Not awaited: an observe call has 5 s, and the command's start waits for its result.
      void (async () => {
        const timer = await ctx.jobs.start({ kind: "timer", runId: agent.runId, owner: { agentId: agent.id }, label: "agent tick", everyMs: 1000 }, { key: `tick-${agent.id}` });
        log({ what: "timer", jobId: timer.jobId, state: timer.state });
        const exec = await ctx.jobs.start({ kind: "exec", runId: agent.runId, owner: { agentId: agent.id }, cmd: ["echo from-plugin"], label: "plugin exec", foregroundMs: 10_000 }, { key: `exec-${agent.id}` });
        log({ what: "exec", jobId: exec.jobId, state: exec.state, result: exec.result });
      })().catch((e) => log({ what: "error", message: String((e as Error)?.message ?? e) }));
    });
    ctx.hooks.on("job.changed", ({ payload: { job, change } }) => {
      if (job.plugin === ctx.plugin.name) log({ what: "changed", jobId: job.jobId, change });
    });
  },
});
