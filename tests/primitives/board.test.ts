import { describe, expect, test } from "bun:test";
import { blockers, casOk, checkKey, claimable, fence, findCycle, leaseMs, pickNext, valueBytes, type BoardTask } from "../../src/primitives/board";

const t = (o: Partial<BoardTask>): BoardTask => ({ taskId: "tsk-1", title: "x", data: null, status: "open", holder: null, epoch: 0, leaseUntil: 0, result: null, ...o });

describe("task board leases", () => {
  test("open is claimable, live claim is not, expired claim is a takeover, done never", () => {
    expect(claimable(t({}), 10)).toEqual({ ok: true, takeover: null });
    expect(claimable(t({ status: "claimed", holder: "a", epoch: 1, leaseUntil: 100 }), 50).ok).toBe(false);
    expect(claimable(t({ status: "claimed", holder: "a", epoch: 1, leaseUntil: 100 }), 100)).toEqual({ ok: true, takeover: { holder: "a", epoch: 1 } });
    expect(claimable(t({ status: "done" }), 0).ok).toBe(false);
  });
  test("fencing: only the current holder+epoch may renew/finish", () => {
    const c = t({ status: "claimed", holder: "b", epoch: 2, leaseUntil: 100 });
    expect(fence(c, "b", 2)).toEqual({ ok: true });
    expect(fence(c, "a", 1)).toMatchObject({ ok: false, code: "lease_lost" });
    expect(fence(c, "b", 1)).toMatchObject({ ok: false, code: "lease_lost" });
    expect(fence(t({ status: "done", holder: "b", epoch: 2 }), "b", 2)).toMatchObject({ ok: false, code: "not_claimed" });
    // expired but not taken over: still the holder's (epoch unchanged)
    expect(fence(t({ status: "claimed", holder: "b", epoch: 2, leaseUntil: 1 }), "b", 2)).toEqual({ ok: true });
  });
  test("pickNext prefers open tasks, then the longest-expired claim", () => {
    const tasks = [
      t({ taskId: "a", status: "claimed", holder: "x", epoch: 1, leaseUntil: 50 }),
      t({ taskId: "b", status: "claimed", holder: "y", epoch: 1, leaseUntil: 20 }),
      t({ taskId: "c", status: "claimed", holder: "z", epoch: 1, leaseUntil: 999 }),
    ];
    expect(pickNext(tasks, 100)?.taskId).toBe("b");
    expect(pickNext([...tasks, t({ taskId: "d" })], 100)?.taskId).toBe("d");
    expect(pickNext([tasks[2]!], 100)).toBeNull();
  });
  test("lease bounds", () => {
    expect(leaseMs(undefined)).toBe(60_000);
    expect(() => leaseMs(5)).toThrow();
    expect(() => leaseMs("x")).toThrow();
  });
});

describe("blackboard", () => {
  test("cas compares versions; 0 means absent", () => {
    expect(casOk(0, 0)).toBe(true);
    expect(casOk(3, 2)).toBe(false);
  });
  test("key syntax", () => {
    expect(checkKey("plan/v1:step-2")).toBe("plan/v1:step-2");
    expect(() => checkKey("has space")).toThrow();
    expect(() => checkKey("")).toThrow();
  });
});

describe("dependencies", () => {
  test("blockers lists deps not done; pickNext skips blocked tasks", () => {
    const a = t({ taskId: "a", status: "done" }), b = t({ taskId: "b", after: ["a"] }), c = t({ taskId: "c", after: ["a", "b"] });
    expect(blockers(c, new Set(["a"]))).toEqual(["b"]);
    expect(pickNext([c, b, a], 0)?.taskId).toBe("b");
    expect(pickNext([c, t({ taskId: "b", after: ["a"], status: "claimed", holder: "x", epoch: 1, leaseUntil: 99 }), a], 0)).toBeNull();
  });
  test("findCycle finds self, 2- and 3-cycles; DAGs pass", () => {
    expect(findCycle(new Map([["a", ["a"]]]))).toEqual(["a", "a"]);
    expect(findCycle(new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]))).toEqual(["a", "b", "c", "a"]);
    expect(findCycle(new Map([["a", []], ["b", ["a"]], ["c", ["a", "b"]]]))).toBeNull();
  });
  test("valueBytes is UTF-8 JSON size", () => {
    expect(valueBytes({ a: 1 })).toBe(7);
    expect(valueBytes("é")).toBe(4);
  });
});
