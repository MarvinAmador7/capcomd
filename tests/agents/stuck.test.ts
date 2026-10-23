// ADR-019 §2: the stuck watch. A first window notifies, a second stops; doing something different clears it.
import { expect, test } from "bun:test";
import { StuckWatch } from "../../src/agents/stuck";

const call = (c: string) => ({ type: "assistant", raw: {}, calls: [c] });
const result = (c: string, error?: string) => ({ type: "user", raw: {}, results: [{ call: c, ...(error !== undefined ? { error } : {}) }] });

test("idle: a notice after the window, a stop after twice the window, cleared by any event", () => {
  const w = new StuckWatch({ idleAfterMs: 1000, repeats: 3, stopIdle: true, stopRepeats: true }, 0);
  expect(w.check(999)).toBeNull();
  expect(w.check(1500)).toMatchObject({ kind: "idle", stop: false });
  expect(w.check(2001)).toMatchObject({ kind: "idle", stop: true });
  w.observe({ type: "assistant", raw: {}, text: "back" }, 1600);
  expect(w.check(1700)).toBeNull();
});

test("spinning: the same call K times in a row is a notice, 2K a stop; a different call resets it", () => {
  const w = new StuckWatch({ idleAfterMs: 60_000, repeats: 3, stopIdle: true, stopRepeats: true }, 0);
  for (let i = 0; i < 2; i++) { w.observe(call('Read {"f":"a"}'), i); w.observe(result('Read {"f":"a"}'), i); }
  expect(w.check(10)).toBeNull();
  w.observe(call('Read {"f":"a"}'), 3);
  expect(w.check(10)).toMatchObject({ kind: "spinning", detail: "the same Read call 3 times in a row", stop: false });
  // Text between the calls doesn't break the run of repeats.
  w.observe({ type: "assistant", raw: {}, text: "hmm" }, 4);
  for (let i = 0; i < 3; i++) w.observe(call('Read {"f":"a"}'), 5);
  expect(w.check(10)).toMatchObject({ kind: "spinning", stop: true });
  w.observe(call('Read {"f":"b"}'), 6);
  expect(w.check(10)).toBeNull();
});

test("failing: the same error (numbers aside) K times is a notice, 2K a stop; that call succeeding clears it", () => {
  const w = new StuckWatch({ idleAfterMs: 60_000, repeats: 3, stopIdle: true, stopRepeats: true }, 0);
  const t = 'Bash {"command":"bun test"}';
  for (let i = 1; i <= 3; i++) { w.observe(call(t), i); w.observe(call(`Edit {"n":${i}}`), i); w.observe(result(t, `x.test.ts:${i} expected 3, got ${i * 7} (${i}ms)`), i); }
  expect(w.check(10)).toMatchObject({ kind: "failing", stop: false });
  expect(w.check(10)!.detail).toStartWith("the same Bash error 3 times: x.test.ts:# expected #");
  // A different error from the same call is counted on its own.
  w.observe(result(t, "SyntaxError: unexpected token"), 4);
  for (let i = 4; i <= 6; i++) w.observe(result(t, `x.test.ts:${i} expected 3, got ${i} (1ms)`), i);
  expect(w.check(10)).toMatchObject({ kind: "failing", stop: true });
  w.observe(result(t), 7);
  expect(w.check(10)).toBeNull();
});

test("by default (no window set) a stuck agent is only noticed, never stopped", () => {
  const w = new StuckWatch({ idleAfterMs: 1000, repeats: 3, stopIdle: false, stopRepeats: false }, 0);
  expect(w.check(10_000)).toMatchObject({ kind: "idle", stop: false });
  w.observe(call('Read {"f":"a"}'), 10_000);
  for (let i = 0; i < 20; i++) w.observe(call('Read {"f":"a"}'), 10_000);
  expect(w.check(10_001)).toMatchObject({ kind: "spinning", stop: false });
});
