// A tool call as one short plain line ("Read ids/v1/schema.json", "Run bun test"), built from the call's structured
// fields. Paths, patterns and commands in it are agent-written: plain text, never a link or an action.
import { opKind } from "./kinds";
import { oneLine } from "./sanitize";

export const SUMMARY_MAX = 200;
const str = (x: unknown) => (typeof x === "string" ? x : "");

/** A shell command as the agent meant it: codex wraps commands in `bash -lc '…'`; a leading `cd <dir> &&` is noise. */
export function shellCommand(cmd: string): string {
	let c = cmd.trim();
	const w = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(c);
	if (w) { c = w[1]!.trim(); const q = c[0]; if ((q === "'" || q === '"') && c.length > 1 && c.endsWith(q)) c = c.slice(1, -1); }
	return c.replace(/^\s*(cd\s+\S+\s*(&&|;)\s*)+/, "").trim();
}

/** capcomd's own tools (MCP tool name or in-VM op) as a phrase. */
export function capcomdSummary(op: string, input: Record<string, any>): string | null {
	switch (opKind(op)) {
		case "spawn": return op.replace(/^capcomd_/, "") === "handoff" ? "Hand off the work" : `Spawn ${typeof input.profile === "string" ? `a ${oneLine(input.profile, 40)}` : "an agent"}`;
		case "wait": return "Wait for agents";
		case "message": return "Send a message";
		case "verify": return "Verify work";
		case "merge": return "Merge work";
		case "report": return "Report the result";
		case "plan": return "Update the task board";
		default: return null;
	}
}

export function claudeSummary(name: string, input: Record<string, any>, rel: (p: unknown) => string): string {
	const file = rel(input.file_path ?? input.notebook_path ?? input.path);
	const s = (() => {
		switch (name) {
			case "Read": case "NotebookRead": return `Read ${file}`;
			case "Edit": case "MultiEdit": case "NotebookEdit": return `Edit ${file}`;
			case "Write": return `Write ${file}`;
			case "Bash": return `Run ${shellCommand(str(input.command))}`;
			case "BashOutput": return "Read shell output";
			case "KillShell": case "KillBash": return "Stop a shell";
			case "Glob": return `Find ${str(input.pattern)}${input.path ? ` in ${rel(input.path)}` : ""}`;
			case "Grep": return `Search the code for ${str(input.pattern)}${input.path ? ` in ${rel(input.path)}` : ""}`;
			case "LS": return `List ${file}`;
			case "WebFetch": return `Fetch ${str(input.url)}`;
			case "WebSearch": return `Search the web for ${str(input.query)}`;
			case "Task": case "Agent": return `Delegate${input.description ? `: ${str(input.description)}` : " a task"}`;
			case "TodoWrite": return "Update the plan";
			case "ExitPlanMode": return "Present the plan";
		}
		const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
		if (mcp) return (mcp[1] === "capcomd" ? capcomdSummary(mcp[2]!, input) : null) ?? `${mcp[1]}: ${mcp[2]}`;
		return name || "Tool call";
	})();
	return oneLine(s, SUMMARY_MAX);
}

export function codexSummary(item: Record<string, any>, rel: (p: unknown) => string): string {
	const s = (() => {
		switch (item.type) {
			case "command_execution": return `Run ${shellCommand(str(item.command))}`;
			case "file_change": {
				const ch: any[] = Array.isArray(item.changes) ? item.changes : [];
				if (ch.length !== 1) return ch.length ? `Edit ${ch.length} files` : "Edit files";
				return `${ch[0]?.kind === "add" ? "Write" : ch[0]?.kind === "delete" ? "Delete" : "Edit"} ${rel(ch[0]?.path)}`;
			}
			case "mcp_tool_call": return (item.server === "capcomd" ? capcomdSummary(str(item.tool), item.arguments && typeof item.arguments === "object" ? item.arguments : {}) : null) ?? `${str(item.server)}: ${str(item.tool)}`;
			case "web_search": return `Search the web for ${str(item.query)}`;
			default: return str(item.type) || "Tool call";
		}
	})();
	return oneLine(s, SUMMARY_MAX);
}
