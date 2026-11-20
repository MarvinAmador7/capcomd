// ADR-026 §7: an agent's bookkeeping is recorded in its thread but marked internal (`internal: true`), and hidden by
// default: arming a wake or booking a check-in, waiting on children, polling its own state, its CLI's system events.
// Only progress the user should read is shown. A client asks for the internal items when it wants them.
//
// The rule is by type, never by what an agent wrote: a capcomd command or MCP tool by its verb (BOOKKEEPING_CALLS), a
// CLI system event by its subtype (BOOKKEEPING_SYSTEM), a line the daemon writes by its own choice (threadNote's
// `internal`). A new kind of bookkeeping (a schedule's command, a scheduler's note) is one entry here.
import { shellCommand } from "./summary";

/**
 * capcomd's own calls that are bookkeeping, by verb (`capcomd <verb>`, MCP `capcomd_<verb>`; two-word verbs as
 * "job output"). Why each is: `wait` arms a wake or waits on what others do; `poll` reads state back.
 */
export const BOOKKEEPING_CALLS: Readonly<Record<string, "wait" | "poll">> = {
	wake: "wait",          // arm, list or cancel a wake; book a check-in (--in, --at)
	await: "wait",
	"wait-any": "wait",
	status: "poll",
	tree: "poll",
	inbox: "poll",
	events: "poll",
	logs: "poll",
	inspect: "poll",
	budget: "poll",
	heartbeat: "poll",
	"job output": "poll",
	"job list": "poll",
};

/** CLI system events that are bookkeeping: Claude Code's subtypes, and model-request retries (codex_retry) and fx's model recovery (fx_model_recovery), which have none. */
export const BOOKKEEPING_SYSTEM: ReadonlySet<string> = new Set(["api_retry", "compact_boundary", "model_fallback", "codex_retry", "fx_model_recovery"]);

/** One `capcomd …` command's verb ("wake", "job output"), or null when it isn't one. */
function capcomdVerb(segment: string): string | null {
	const m = /^\s*(?:\S*\/)?capcomd\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/.exec(segment);
	if (!m) return null;
	const two = m[2] ? `${m[1]} ${m[2]}` : null;
	return two && two in BOOKKEEPING_CALLS ? two : m[1]!;
}

/**
 * A shell command that is only bookkeeping: every command in it (split on `&&`, `||`, `;` and newlines) is a
 * bookkeeping `capcomd` call (a pipe into another program, `| jq`, is still that call). Anything else in it is work.
 */
export function isBookkeepingCommand(command: string): boolean {
	const c = shellCommand(command);
	if (!c) return false;
	const parts = c.split(/&&|\|\||;|\n/).map((p) => p.trim()).filter(Boolean);
	return parts.length > 0 && parts.every((p) => { const v = capcomdVerb(p); return v !== null && v in BOOKKEEPING_CALLS; });
}

/** capcomd's MCP tool as the CLI names it (Claude `mcp__capcomd__capcomd_wake`, Codex and fx `capcomd_wake` on server capcomd). */
export function isBookkeepingTool(tool: string): boolean {
	const m = /^(?:mcp__capcomd__)?capcomd_([a-z_]+)$/.exec(tool);
	if (!m) return false;
	const verb = m[1]!.replace(/^wait_any$/, "wait-any").replace(/^job_/, "job ");
	return verb in BOOKKEEPING_CALLS;
}
