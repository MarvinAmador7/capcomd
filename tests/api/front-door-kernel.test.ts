// Capability ops.front_door (plugin API §6.1): the daemon's side of a front door's decision on a merge. The front door
// asks again with the same body while the decision runs (a 202, then a poll): that poll joins it. With the front door's
// own `key`, a poll that comes just after the decision ended gets its record too, instead of deciding a second time: an
// approval that a plugin's merge.landing then held would otherwise be approved again, past the hold, by nobody.
import { expect, mock, test } from "bun:test";

const decided: Array<{ runId: string; mergeId: string; approve: boolean }> = [];
let finish: (v: Record<string, unknown>) => void = () => {};
mock.module("../../src/primitives/ops", () => ({
  settleCleanups: async () => {},
  decideMerge: (runId: string, mergeId: string, o: { approve: boolean }) => {
    decided.push({ runId, mergeId, approve: o.approve });
    return new Promise<Record<string, unknown>>((res) => { finish = res; });
  },
}));
const { kernelFrontDoor } = await import("../../src/api/front-door");

test("a keyed decision asked again, while it runs or once it ended, is the same decision", async () => {
  const ops = kernelFrontDoor();
  const first = await ops.decide("run-1", "mrg-1", { approve: true, by: "cli", key: "fd-a" });
  const joined = await ops.decide("run-1", "mrg-1", { approve: true, by: "cli", key: "fd-a" });
  expect(decided).toHaveLength(1);
  finish({ id: "mrg-1", state: "awaiting_approval", heldBy: { plugin: "acme" } });
  expect(await first.done).toEqual(await joined.done);
  await Bun.sleep(0);
  // Ended (held by a plugin): the front door's next poll gets that record; nothing is approved again.
  const after = await ops.decide("run-1", "mrg-1", { approve: true, by: "cli", key: "fd-a" });
  expect(await after.done).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "acme" } });
  expect(decided).toHaveLength(1);
  // A new decision (the person approves the hold: a new command, a new key) is decided.
  void ops.decide("run-1", "mrg-1", { approve: true, by: "cli", key: "fd-b" });
  await Bun.sleep(0);
  expect(decided).toHaveLength(2);
  finish({ id: "mrg-1", state: "merged" });
});

test("without a key, an ended decision isn't kept: the next one is decided (decideMerge's CAS judges it)", async () => {
  decided.length = 0;
  const ops = kernelFrontDoor();
  const a = await ops.decide("run-2", "mrg-2", { approve: false, by: "cli" });
  finish({ id: "mrg-2", state: "failed" });
  await a.done;
  await Bun.sleep(0);
  void ops.decide("run-2", "mrg-2", { approve: false, by: "cli" });
  await Bun.sleep(0);
  expect(decided).toHaveLength(2);
});
