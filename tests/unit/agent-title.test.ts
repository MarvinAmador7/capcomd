// Agent titles (capability agents.title): how a title is written (normalized, refused with a sentence), the title the
// daemon derives from a task when nobody named the agent, which title shows (the user's sticks; then the latest of
// self, parent and driver; then the derived one), and the rate limit on an agent's and a parent's renames.
import { describe, expect, test } from "bun:test";
import { applyTitle, cleanTitle, derivedTitle, normalizeTitle, RENAME_WINDOW_MS, RENAMES_MAX, renameRefusal, shownTitle, TITLE_MAX_CHARS, type TitleState } from "../../src/primitives/agent-title";

describe("normalizeTitle", () => {
	test("trimmed, one line, whitespace collapsed, lowercase", () => {
		expect(normalizeTitle("  Login   Redirect ")).toEqual({ ok: true, title: "login redirect" });
		expect(normalizeTitle("login\nredirect\r\n")).toEqual({ ok: true, title: "login redirect" });
		expect(normalizeTitle("Fix\tSUM")).toEqual({ ok: true, title: "fix sum" });
	});
	test("control and format characters go (bidi overrides, zero-width, BOM)", () => {
		expect(normalizeTitle("lo‮gin​ re﻿direct\u0007")).toEqual({ ok: true, title: "login redirect" });
		expect(cleanTitle("a b")).toBe("a b");
	});
	test("refused with a sentence: no words, more than 4 words, more than 32 characters (never cut)", () => {
		const empty = normalizeTitle("  ​\n ");
		expect(empty.ok).toBe(false);
		expect((empty as { error: string }).error).toContain("at least one word");
		const five = normalizeTitle("one two three four five");
		expect((five as { error: string }).error).toBe('a title is 1 to 4 words, not 5: say what you\'re working on in fewer words, e.g. "login redirect"');
		const long = normalizeTitle("x".repeat(TITLE_MAX_CHARS + 1));
		expect((long as { error: string }).error).toBe("a title is at most 32 characters, not 33: pick shorter words");
		expect(normalizeTitle("x".repeat(TITLE_MAX_CHARS))).toEqual({ ok: true, title: "x".repeat(32) });
		expect(normalizeTitle(42 as unknown).ok).toBe(false);
	});
	test("characters are counted as people see them (an emoji is one)", () => {
		expect(normalizeTitle("👩‍💻".repeat(32)).ok).toBe(true);
		expect(normalizeTitle("👩‍💻".repeat(33)).ok).toBe(false);
	});
});

describe("derivedTitle", () => {
	const cases: Array<[string | null, string | null]> = [
		["Fix the login redirect bug in auth.ts", "fix login redirect bug"],
		["Add a multiply(a, b) function to src/math.ts and a bun test for it", "add multiply function"],
		["[listen] edit sum.ts", "edit sum.ts"],
		["[title:login redirect] fix it", "fix it"],
		["Goal: add dark mode to the settings window\n\nYou are the planner for this goal.", "add dark mode"],
		["Please add dark mode to the settings window", "add dark mode"],
		["can you bump the rivetkit pin to 2.3.31?", "bump rivetkit pin"],
		["  \n\n## Migrate the `ids/v1` schema to **v2**\nDetails", "migrate ids/v1 schema"],
		["- [ ] write docs", "write docs"],
		["Refactor the scheduler: split the lease logic out of scope.ts", "refactor scheduler"],
		["Supercalifragilisticexpialidociousandmore words", "supercalifragilisticexpialidocio"],
		["", null],
		["   \n\n", null],
		[null, null],
		["the a", null],
	];
	for (const [task, title] of cases) test(`${JSON.stringify(task?.slice(0, 40))} → ${JSON.stringify(title)}`, () => expect(derivedTitle(task)).toBe(title));
	test("always a title a person could have given: normalized, at most 4 words and 32 characters", () => {
		for (const [task] of cases) {
			const t = derivedTitle(task);
			if (t !== null) expect(normalizeTitle(t)).toEqual({ ok: true, title: t });
		}
	});
	test("deterministic", () => expect(derivedTitle("Fix the flaky login test")).toBe(derivedTitle("Fix the flaky login test")));
});

describe("which title shows", () => {
	const task = "Fix the login redirect bug";
	const t0 = 1_792_900_000_000;
	test("nobody named it: derived from the task (null without one)", () => {
		expect(shownTitle(null, task)).toEqual({ title: "fix login redirect bug", titleSource: "derived" });
		expect(shownTitle(null, "")).toEqual({ title: null, titleSource: null });
	});
	test("between self and parent (and the driver) the latest wins", () => {
		let s: TitleState | null = null;
		s = applyTitle(s, task, { title: "auth fix", by: "parent", setBy: "agt-p", now: t0 }).next;
		expect(shownTitle(s, task)).toEqual({ title: "auth fix", titleSource: "parent" });
		const self = applyTitle(s, task, { title: "login redirect", by: "self", setBy: "agt-c", now: t0 + 1 });
		expect(self).toMatchObject({ changed: true, shown: true, title: "login redirect", titleSource: "self" });
		const drv = applyTitle(self.next, task, { title: "redirect loop", by: "driver", setBy: "driver", now: t0 + 2 });
		expect(drv).toMatchObject({ shown: true, titleSource: "driver" });
	});
	test("a user title sticks: later agent renames are recorded under it (shown: false); clearing reveals the latest", () => {
		const user = applyTitle(null, task, { title: "my tab", by: "user", setBy: "user", now: t0 });
		expect(user).toMatchObject({ changed: true, shown: true, title: "my tab", titleSource: "user" });
		const later = applyTitle(user.next, task, { title: "login redirect", by: "self", setBy: "agt-c", now: t0 + 1 });
		expect(later).toMatchObject({ changed: true, shown: false, title: "my tab", titleSource: "user" });
		const cleared = applyTitle(later.next, task, { title: null, by: "user", setBy: "user", now: t0 + 2 });
		expect(cleared).toMatchObject({ changed: true, shown: true, title: "login redirect", titleSource: "self" });
		// Nothing to clear: no change. Without any agent title, clearing shows the derived one.
		expect(applyTitle(cleared.next, task, { title: null, by: "user", setBy: "user", now: t0 + 3 }).changed).toBe(false);
		const onlyUser = applyTitle(user.next, task, { title: null, by: "user", setBy: "user", now: t0 + 4 });
		expect(onlyUser).toMatchObject({ title: "fix login redirect bug", titleSource: "derived" });
	});
	test("the same title from the same source again changes nothing (and isn't counted)", () => {
		const a = applyTitle(null, task, { title: "login redirect", by: "self", setBy: "agt-c", now: t0 });
		const b = applyTitle(a.next, task, { title: "login redirect", by: "self", setBy: "agt-c", now: t0 + 1 });
		expect(b.changed).toBe(false);
		expect(b.next.count).toBe(1);
	});
	test("only self and parent renames count; a title given at spawn doesn't", () => {
		const spawn = applyTitle(null, task, { title: "auth fix", by: "parent", setBy: "agt-p", now: t0, counted: false });
		expect(spawn.next.count ?? 0).toBe(0);
		const drv = applyTitle(spawn.next, task, { title: "x", by: "driver", setBy: "driver", now: t0 });
		expect(drv.next.count ?? 0).toBe(0);
		const self = applyTitle(drv.next, task, { title: "y", by: "self", setBy: "agt-c", now: t0 });
		expect(self.next).toMatchObject({ count: 1, last: { "agt-c": t0 } });
	});
	test("only the user clears", () => {
		expect(() => applyTitle(null, task, { title: null, by: "self", setBy: "agt-c", now: t0 })).toThrow();
	});
});

describe("renameRefusal", () => {
	const t0 = 1_792_900_000_000;
	test("one rename per setter every 30 s, with when to try again", () => {
		const s = { count: 1, last: { "agt-c": t0 } };
		expect(renameRefusal(s, "agt-c", "your tab", t0 + 12_000)).toBe("you renamed your tab 12 s ago: rename at most once every 30 s (try again in 18 s), and only when your focus really changes");
		expect(renameRefusal(s, "agt-c", "your tab", t0 + RENAME_WINDOW_MS)).toBeNull();
		// Another setter (the parent) has its own window.
		expect(renameRefusal(s, "agt-p", "agt-c", t0 + 1)).toBeNull();
		expect(renameRefusal(null, "agt-c", "your tab", t0)).toBeNull();
	});
	test("at most 20 renames per agent (or run)", () => {
		expect(renameRefusal({ count: RENAMES_MAX, last: {} }, "agt-c", "your tab", t0)).toBe("your tab has been renamed 20 times, the most capcomd allows: keep the title it has");
		expect(renameRefusal({ count: RENAMES_MAX - 1, last: {} }, "agt-c", "the run", t0)).toBeNull();
	});
});
