// An agent naming its tab (capcomd agents.title): which commands count (plain `capcomd title <words>` only, shell
// words parsed properly, a Codex `bash -lc` wrapper looked through), and the thread leaving every naming call out
// (its result too) while its other tool calls stay.
import { describe, expect, test } from "bun:test";
import { codexNaming, fxNaming, isClaudeNamingCall, isCodexNamingCall, isFxNamingCall, namingCalls, namingCommand, shellWords, threadBuilder, type ItemDraft } from "../src/index";

describe("shellWords", () => {
	test("plain words, quoted or not, with escapes", () => {
		expect(shellWords(`capcomd title "login redirect"`)).toEqual(["capcomd", "title", "login redirect"]);
		expect(shellWords(`capcomd title 'login  redirect'`)).toEqual(["capcomd", "title", "login  redirect"]);
		expect(shellWords(`capcomd   title login\\ redirect`)).toEqual(["capcomd", "title", "login redirect"]);
		expect(shellWords(`capcomd title "say \\"hi\\""`)).toEqual(["capcomd", "title", 'say "hi"']);
		expect(shellWords(`a"b"'c'`)).toEqual(["abc"]);
	});
	test("anything a shell would do more with is not plain words", () => {
		for (const c of [`a && b`, `a | b`, `a; b`, `a > f`, `a < f`, `$(x)`, "`x`", `"$HOME"`, `$X`, `a *`, `(a)`, `a # c`, `"open`, `'open`, `a\nb`, `a &`]) {
			expect(shellWords(c)).toBeNull();
		}
	});
});

describe("namingCommand", () => {
	test("only `capcomd title <words>` by itself names the tab", () => {
		expect(namingCommand(`capcomd title "Login Redirect"`)).toBe("Login Redirect");
		expect(namingCommand(`capcomd title login redirect`)).toBe("login redirect");
		expect(namingCommand(`  capcomd title 'parquet shards'  `)).toBe("parquet shards");
		// Codex runs each command through a shell.
		expect(namingCommand(`bash -lc 'capcomd title "login redirect"'`)).toBe("login redirect");
		expect(namingCommand(`/bin/sh -c "capcomd title redirect"`)).toBe("redirect");
	});
	test("a command that does something else too, or names another agent or the run, is not a rename of its own", () => {
		for (const c of [
			`capcomd title x && rm -rf /`, `capcomd title x; rm -rf /`, `capcomd title x | tee f`, `capcomd title "$(whoami)"`,
			`capcomd title $USER`, `bash -lc 'capcomd title x && rm -rf /'`, `capcomd title`, `capcomd status`, `echo capcomd title x`,
			`capcomd title agt-abc123 "child"`, `capcomd title --run "the run"`, `sudo capcomd title x`, `./capcomd title x`,
		]) expect(namingCommand(c)).toBeNull();
	});
	test("the MCP tool, for its own tab only", () => {
		expect(codexNaming({ type: "mcp_tool_call", server: "capcomd", tool: "capcomd_title", arguments: { title: "login redirect" } })).toBe("login redirect");
		expect(codexNaming({ type: "mcp_tool_call", server: "capcomd", tool: "capcomd_title", arguments: { title: "x", agent: "agt-1" } })).toBeNull();
		expect(namingCalls({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "mcp__capcomd__capcomd_title", input: { title: "auth fix" } }] } }))
			.toEqual([{ callId: "u1", title: "auth fix" }]);
		expect(namingCalls({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'capcomd title login'" } })).toEqual([{ callId: "i1", title: "login" }]);
		expect(namingCalls({ type: "item.completed", item: { id: "i2", type: "command_execution", command: "capcomd title x && y" } })).toEqual([]);
	});
	test("any naming call (a child's, the run's) is bookkeeping; other capcomd calls aren't", () => {
		expect(isClaudeNamingCall("Bash", { command: `capcomd title agt-1 "child"` })).toBe(true);
		expect(isClaudeNamingCall("Bash", { command: `capcomd title --run "run"` })).toBe(true);
		expect(isClaudeNamingCall("Bash", { command: `capcomd title x && rm -rf /` })).toBe(false);
		expect(isClaudeNamingCall("Bash", { command: `capcomd spawn --task x` })).toBe(false);
		expect(isClaudeNamingCall("mcp__capcomd__capcomd_title", { title: "x", run: true })).toBe(true);
		expect(isCodexNamingCall({ type: "mcp_tool_call", server: "capcomd", tool: "capcomd_spawn" })).toBe(false);
	});
});

describe("the thread leaves naming calls out", () => {
	const run = (cli: "claude" | "codex", events: unknown[]) => {
		const b = threadBuilder({ cli, idPrefix: "itm-n", now: () => 0 });
		const out: ItemDraft[] = [];
		for (const e of events) out.push(...b.event(e));
		out.push(...b.finish());
		return [...new Map(out.map((i) => [i.id, i])).values()];   // the latest revision of each item
	};
	test("claude: the Bash call and the MCP tool, and their results; other calls stay", () => {
		const items = run("claude", [
			{ type: "assistant", message: { id: "m1", content: [
				{ type: "tool_use", id: "n1", name: "Bash", input: { command: `capcomd title "login redirect"` } },
				{ type: "tool_use", id: "n2", name: "mcp__capcomd__capcomd_title", input: { title: "x" } },
				{ type: "tool_use", id: "n3", name: "Bash", input: { command: `capcomd title x && rm -rf /` } },
				{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "a.ts" } },
			] } },
			{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "n1", content: "ok: login redirect" }, { type: "tool_result", tool_use_id: "n2", content: "ok" }] } },
		]);
		expect(items.filter((i) => i.kind === "tool").map((i) => i.tool!.callId).sort()).toEqual(["e1", "n3"]);
		expect(items.some((i) => i.kind === "other")).toBe(false);   // no orphaned results
	});
	test("codex: a naming command or MCP call opens no item", () => {
		const items = run("codex", [
			{ type: "item.started", item: { id: "c1", type: "command_execution", command: `bash -lc 'capcomd title login'` } },
			{ type: "item.completed", item: { id: "c1", type: "command_execution", command: `bash -lc 'capcomd title login'`, exit_code: 0, aggregated_output: "ok: login" } },
			{ type: "item.completed", item: { id: "c2", type: "mcp_tool_call", server: "capcomd", tool: "capcomd_title", arguments: { title: "x" }, status: "completed" } },
			{ type: "item.completed", item: { id: "c3", type: "command_execution", command: "bun test", exit_code: 0, aggregated_output: "" } },
		]);
		expect(items.filter((i) => i.kind === "tool").map((i) => i.tool!.callId)).toEqual(["c3"]);
	});
});

describe("fx (the bridge's tool_call lines)", () => {
	const tc = (name: string, rawInput: unknown, mcp?: unknown) => ({ type: "update", update: { sessionUpdate: "tool_call", toolCallId: "c1", name, rawInput, ...(mcp ? { _meta: { fx: { toolCall: { mcp } } } } : {}) } });
	test("a shell `capcomd title` by itself, or the capcomd_title tool, names its tab", () => {
		expect(namingCalls(tc("shell", { action: "run", command: "capcomd title login redirect" }))).toEqual([{ callId: "c1", title: "login redirect" }]);
		expect(namingCalls(tc("mcp_capcomd_capcomd_title", { title: "parquet" }, { server: "capcomd", tool: "capcomd_title" }))).toEqual([{ callId: "c1", title: "parquet" }]);
		expect(namingCalls(tc("shell", { action: "run", command: "capcomd title x && ls" }))).toEqual([]);
		expect(fxNaming(tc("shell", { action: "run", command: "capcomd title agt-1 child" }).update)).toBeNull();
		expect(isFxNamingCall(tc("shell", { action: "run", command: "capcomd title agt-1 child" }).update)).toBe(true);
	});
});
