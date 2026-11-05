// Test plugin (tests/scenarios/gates.test.ts, merge-hold.test.ts): holds every merge for a person's approval (§6.6.15).
// After test-gate in the listeners' order (by name), so an ordinary merge is denied before it is asked; `merge
// --operator` asks both. Into a target named hold-varies…, its reason changes on every call (it counts them); into
// hold-varies-named it also names the hold (`holdId`), so an approval of it holds across calls.
import { definePlugin } from "../../../../packages/plugin/src/index";

const HOLD = "the test holder wants a person to look";
let calls = 0;

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("merge.landing", ({ payload: p }) => {
      if (!p.target.branch.startsWith("hold-varies")) return { decision: "hold", reason: HOLD };
      calls++;
      return { decision: "hold", reason: `${HOLD} (call ${calls})`, ...(p.target.branch === "hold-varies-named" ? { holdId: "look-once" } : {}) };
    });
  },
});
