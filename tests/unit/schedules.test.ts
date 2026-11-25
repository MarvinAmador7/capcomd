// ADR-026 §3 schedules (Vercel Board's rules), on the wakes' own SQL in a scratch SQLite: a recurring check-in fires once
// per slot, its message's id is derived from (schedule, n), a slot that came and went while nothing ran is skipped (only
// the latest due one fires), and it ends after its last slot. Also what `--every` accepts.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { WAKES_SQL, fireSlot, parseFilter, recurring, wakeRow, type WakeRow } from "../../src/actors/wakes";

function scratch() {
  const db = new Database(":memory:");
  for (const q of WAKES_SQL) db.run(q);
  db.run("ALTER TABLE wakes ADD COLUMN slot INTEGER NOT NULL DEFAULT 0");
  db.run("ALTER TABLE wakes ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0");
  db.run("CREATE TABLE messages (seq INTEGER PRIMARY KEY, to_agent TEXT NOT NULL, from_agent TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, idem_key TEXT UNIQUE, skills TEXT)");
  const tx = { execute: async (sql: string, ...args: any[]) => db.query(sql).all(...args) } as any;
  const events: Array<{ type: string; data: any; key: string }> = [];
  const addEvent = (async (_tx: unknown, type: string, _agent: string, data: any, key: string) => { events.push({ type, data, key }); }) as any;
  return { db, tx, events, addEvent };
}
const arm = (db: Database, every: number, from: number, times: number | null) => {
  const filter = parseFilter({ kind: "timer", every, from, times });
  db.query("INSERT INTO wakes (wake_id, agent_id, filter, note, state, at, created_at) VALUES ('wk-s', 'agt-a', ?, 'look at CI', 'armed', ?, ?)").run(JSON.stringify(filter), from, from - 1000);
};
const row = (db: Database): WakeRow => wakeRow(db.query("SELECT * FROM wakes WHERE wake_id = 'wk-s'").get());

test("a recurring check-in fires once per slot, with a message id per (schedule, n), and ends after its last", async () => {
  const { db, tx, events, addEvent } = scratch();
  const t0 = 1_800_000_000_000, every = 60_000;
  arm(db, every, t0, 3);
  expect(recurring(row(db).filter)).toBe(true);
  expect(await fireSlot(tx, row(db), addEvent, t0)).toBe(t0 + every);
  // The same slot's alarm again (a duplicate, or a retry): nothing more.
  expect(await fireSlot(tx, row(db), addEvent, t0 + 10)).toBeNull();
  expect(await fireSlot(tx, row(db), addEvent, t0 + every + 5)).toBe(t0 + 2 * every);
  expect(await fireSlot(tx, row(db), addEvent, t0 + 2 * every)).toBeNull();
  const msgs = db.query("SELECT idem_key, from_agent, body FROM messages ORDER BY seq").all() as any[];
  expect(msgs.map((m) => m.idem_key)).toEqual(["wake-wk-s-0", "wake-wk-s-1", "wake-wk-s-2"]);
  expect(msgs.every((m) => m.from_agent === "wake-wk-s")).toBe(true);
  expect(msgs[0].body).toContain("Wake-up wk-s: its check-in time came (1 of 3, every 1 min).");
  expect(msgs[0].body).toContain("Your note when you asked for it: look at CI");
  expect(events.map((e) => [e.key, e.data.slot])).toEqual([["woken-wk-s-0", 0], ["woken-wk-s-1", 1], ["woken-wk-s-2", 2]]);
  expect(row(db)).toMatchObject({ state: "fired", slot: 3, skipped: 0 });
});

test("missed slots are skipped: only the latest due one fires, saying how many it skipped; a missed last slot ends it", async () => {
  const { db, tx, events, addEvent } = scratch();
  const t0 = 1_800_000_000_000, every = 60_000;
  arm(db, every, t0, null);
  await fireSlot(tx, row(db), addEvent, t0);
  // Nothing ran for three and a half intervals: slots 1-2 are skipped, slot 3 fires, slot 4 is next.
  expect(await fireSlot(tx, row(db), addEvent, t0 + 3.5 * every)).toBe(t0 + 4 * every);
  expect(row(db)).toMatchObject({ state: "armed", slot: 4, skipped: 2 });
  expect(events.at(-1)!.data).toMatchObject({ slot: 3, skipped: 2 });
  const last = db.query("SELECT body FROM messages ORDER BY seq DESC LIMIT 1").get() as any;
  expect(last.body).toContain("(4, every 1 min)");
  expect(last.body).toContain("2 earlier check-ins were missed while nothing ran, and skipped.");
  // A bounded one whose last slot came and went: it ends, delivering nothing late.
  const b = scratch();
  arm(b.db, every, t0, 2);
  await fireSlot(b.tx, row(b.db), b.addEvent, t0);
  expect(await fireSlot(b.tx, row(b.db), b.addEvent, t0 + 5 * every)).toBeNull();
  expect(row(b.db)).toMatchObject({ state: "fired", slot: 2, skipped: 1 });
  expect((b.db.query("SELECT COUNT(*) AS n FROM messages").get() as any).n).toBe(1);
});

test("what --every accepts: at least the minimum interval, at most 6 hours, 1-1000 times", () => {
  const t = 1_800_000_000_000;
  expect(parseFilter({ kind: "timer" })).toEqual({ kind: "timer" });
  expect(parseFilter({ kind: "timer", every: 300_000, from: t, times: 4 })).toEqual({ kind: "timer", every: 300_000, times: 4, from: t });
  expect(() => parseFilter({ kind: "timer", every: 5_000, from: t })).toThrow(/at most once every 1 min/);
  expect(() => parseFilter({ kind: "timer", every: 7 * 3600_000, from: t })).toThrow(/at least every/);
  expect(() => parseFilter({ kind: "timer", every: 300_000, from: t, times: 0 })).toThrow(/--times/);
});
