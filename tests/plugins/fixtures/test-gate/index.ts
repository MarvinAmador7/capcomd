// Test plugin (tests/scenarios/gates.test.ts): a judge of the same shape as the reviewer gate, ANDed with it and the
// checks (§6.6.13): it denies a verification whose task says JUDGE-DENY and passes the rest. At merge.landing it denies
// every merge, so only `merge --operator` lands (past it, recorded: §6.5).
import { definePlugin } from "../../../../packages/plugin/src/index";

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("verify.judging", (call) => {
      if (call.payload.task?.text.includes("JUDGE-DENY")) return { decision: "deny", reason: "the test judge refuses this change", reasons: ["its task says JUDGE-DENY"] };
      return { decision: "allow" };
    });
    ctx.hooks.on("merge.landing", () => ({ decision: "deny", reason: "the test gate lands nothing" }));
  },
});
