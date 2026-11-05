// Test plugin (tests/scenarios/gates.test.ts): holds every merge for a person's approval (§6.6.15). After test-gate in
// the listeners' order (by name), so an ordinary merge is denied before it is asked; `merge --operator` asks both.
import { definePlugin } from "../../../../packages/plugin/src/index";

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("merge.landing", () => ({ decision: "hold", reason: "the test holder wants a person to look" }));
  },
});
