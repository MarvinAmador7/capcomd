// What kind of step a tool call is, from its structured fields only (tool name, command, capcomd op). Shared by the
// daemon's activity line (src/agents/activity.ts) and the thread's tool items (their icon hint).

/** Icon hint. Clients must treat a kind they don't know as "tool" (more may be added). */
export const ACTIVITY_KINDS = [
	"read", "edit", "write", "search", "run", "test", "build", "install", "check", "git", "web",
	"spawn", "wait", "message", "verify", "merge", "report", "delegate", "plan", "think", "tool",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** A shell command's kind, from what it runs. */
export function commandKind(cmd: string): ActivityKind {
	// Look at the command after `cd dir &&`, env assignments and `timeout N`.
	const c = cmd.replace(/^\s*(cd\s+\S+\s*(&&|;)\s*)+/, "").replace(/^\s*(\w+=\S*\s+)+/, "").replace(/^\s*timeout\s+\S+\s+/, "").trim();
	const m = (re: RegExp) => re.test(c);
	if (m(/^capcomd\s+(spawn|handoff)\b/)) return "spawn";
	if (m(/^capcomd\s+(wait|await|wait-any)\b/)) return "wait";
	if (m(/^capcomd\s+send\b/)) return "message";
	if (m(/^capcomd\s+verify\b/)) return "verify";
	if (m(/^capcomd\s+merge\b/)) return "merge";
	if (m(/^capcomd\s+result\b/)) return "report";
	if (m(/\b(bun|npm|pnpm|yarn|deno)\s+(run\s+)?test\b|\b(pytest|vitest|jest|mocha|rspec|phpunit|tox)\b|\b(go|cargo|swift|dotnet|mix)\s+test\b|\bmake\s+(test|check)\b|\bgradle\w*\s+test\b|\bmvn\s+test\b/)) return "test";
	if (m(/\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\b(poetry|bundle|composer)\s+install\b|\bgo\s+mod\s+(download|tidy)\b|\bcargo\s+fetch\b|\b(apt|apt-get|brew)\s+install\b/)) return "install";
	if (m(/\b(bun|npm|pnpm|yarn)\s+run\s+(typecheck|lint|check|format)\b|\b(tsc|eslint|biome|ruff|flake8|mypy|pyright|prettier|clippy|golangci-lint|swiftlint)\b|\bcargo\s+(check|clippy)\b|\bgo\s+vet\b/)) return "check";
	if (m(/\b(bun|npm|pnpm|yarn)\s+run\s+build\b|^make\b|\b(cargo|go|swift|dotnet)\s+build\b|\b(gradle\w*|mvn)\b/)) return "build";
	if (m(/^git\b|^gh\b/)) return "git";
	if (m(/^(curl|wget|http)\b/)) return "web";
	if (m(/^(cat|head|tail|less|more|nl|wc|sed\s+-n|awk)\b/)) return "read";
	if (m(/^(ls|find|tree|rg|grep|ag|fd|ack|locate)\b/)) return "search";
	return "run";
}

/** capcomd's own tools, as an MCP tool name (capcomd_spawn) or an in-VM RPC op (spawn). */
export function opKind(op: string): ActivityKind | null {
	switch (op.replace(/^capcomd_/, "")) {
		case "spawn": case "handoff": return "spawn";
		case "await": case "wait": case "wait-any": case "wait_any": return "wait";
		case "send": return "message";
		case "verify": return "verify";
		case "merge": return "merge";
		case "result": return "report";
		case "task": return "plan";
		default: return null;
	}
}

/** A Claude Code tool_use block's kind. */
export function claudeToolKind(name: string, input: Record<string, any>): ActivityKind {
	switch (name) {
		case "Read": case "NotebookRead": return "read";
		case "Edit": case "MultiEdit": case "NotebookEdit": return "edit";
		case "Write": return "write";
		case "Glob": case "Grep": case "LS": return "search";
		case "Bash": return commandKind(String(input.command ?? ""));
		case "BashOutput": case "KillShell": case "KillBash": return "run";
		case "WebFetch": case "WebSearch": return "web";
		case "Task": case "Agent": return "delegate";
		case "TodoWrite": case "ExitPlanMode": return "plan";
	}
	const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
	if (mcp && mcp[1] === "capcomd") { const k = opKind(mcp[2]!); if (k) return k; }
	return "tool";
}

/** A Codex item's kind (command_execution, file_change, mcp_tool_call, web_search, todo_list, reasoning, agent_message). */
export function codexItemKind(item: Record<string, any>): ActivityKind | null {
	switch (item.type) {
		case "command_execution": return commandKind(String(item.command ?? ""));
		case "file_change": { const ch = Array.isArray(item.changes) ? item.changes : []; return ch.length && ch.every((c: any) => c?.kind === "add") ? "write" : "edit"; }
		case "mcp_tool_call": return (item.server === "capcomd" ? opKind(String(item.tool ?? "")) : null) ?? "tool";
		case "web_search": return "web";
		case "todo_list": return "plan";
		case "reasoning": case "agent_message": return "think";
		default: return null;
	}
}
