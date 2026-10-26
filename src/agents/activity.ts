// What an agent is doing right now, as a short plain-language line (harness.v1 Agent.activity, agent.activity_changed).
// The daemon classifies the agent's structured events (tool names, commands, file paths, capcomd ops) into a fixed
// vocabulary plus a count. Nothing the agent wrote reaches the line: paths and commands only pick the kind and are
// counted, never shown. Consecutive events of one kind coalesce ("Reading 4 files") and each agent's line is written
// at most once per `minMs` (default 1s), so a busy agent costs one small row update a second, not one per event.
import type { AgentEvent } from "./types";
import { ACTIVITY_KINDS, commandKind, opKind, type ActivityKind } from "../../packages/agent-thread/src/kinds";

// The vocabulary and the command/op classifiers live in packages/agent-thread (the thread's tool items use them too).
export { ACTIVITY_KINDS, commandKind, opKind, type ActivityKind };

/** One observed step: its kind, and what it acted on (a path, a command), used only to count distinct targets. */
export type ActivityStep = { kind: ActivityKind; target: string };
/** What is stored on the agent: the current kind, how many distinct targets the streak touched, when it last changed. */
export type StoredActivity = { kind: ActivityKind; n: number; at: number };

const step = (kind: ActivityKind, target: unknown = ""): ActivityStep => ({ kind, target: typeof target === "string" ? target : JSON.stringify(target ?? "") });

function claudeTool(name: string, input: Record<string, any>): ActivityStep {
	const file = input.file_path ?? input.notebook_path ?? input.path ?? "";
	switch (name) {
		case "Read": case "NotebookRead": return step("read", file);
		case "Edit": case "MultiEdit": case "NotebookEdit": return step("edit", file);
		case "Write": return step("write", file);
		case "Glob": case "Grep": case "LS": return step("search", input);
		case "Bash": return step(commandKind(String(input.command ?? "")), input.command);
		case "BashOutput": case "KillShell": case "KillBash": return step("run", input.bash_id ?? input.shell_id);
		case "WebFetch": case "WebSearch": return step("web", input.url ?? input.query);
		case "Task": case "Agent": return step("delegate", input);
		case "TodoWrite": case "ExitPlanMode": return step("plan");
	}
	const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
	if (mcp && mcp[1] === "capcomd") { const k = opKind(mcp[2]!); if (k) return step(k, input); }
	return step("tool", name);
}

/**
 * The steps in one adapter event, in order. Claude: each tool_use block of an assistant message. Codex: each started or
 * completed tool item. Model text (claude assistant text, codex reasoning/agent_message) is "think".
 */
export function activityOf(ev: AgentEvent): ActivityStep[] {
	const raw = ev.raw as any;
	const content = raw?.message?.content;
	if (ev.type === "assistant" && Array.isArray(content)) {
		const uses = content.filter((c: any) => c?.type === "tool_use");
		if (uses.length) return uses.map((u: any) => claudeTool(String(u.name ?? ""), u.input && typeof u.input === "object" ? u.input : {}));
		if (content.some((c: any) => c?.type === "text" || c?.type === "thinking")) return [step("think")];
		return [];
	}
	const item = raw?.item;
	if ((ev.type === "item_started" || ev.type === "item_completed" || ev.type === "item_updated") && item && typeof item === "object") {
		const id = String(item.id ?? "");
		switch (item.type) {
			case "command_execution": return [step(commandKind(String(item.command ?? "")), id || item.command)];
			case "file_change": {
				const changes = Array.isArray(item.changes) ? item.changes : [];
				if (!changes.length) return [step("edit", id)];
				return changes.map((ch: any) => step(ch?.kind === "add" ? "write" : "edit", ch?.path));
			}
			case "mcp_tool_call": { const k = item.server === "capcomd" ? opKind(String(item.tool ?? "")) : null; return [step(k ?? "tool", id)]; }
			case "web_search": return [step("web", item.query ?? id)];
			case "todo_list": return [step("plan")];
			case "reasoning": case "agent_message": return [step("think")];
		}
	}
	return [];
}

/**
 * Coalesce steps into the agent's current activity and write it, throttled. A step of the current kind adds its target
 * to the streak (n = distinct targets); another kind starts a new streak. "think" never interrupts a streak: it only
 * shows when nothing else has yet. A write happens when the line would change, at most once per `minMs`; a change
 * inside the window is written when it ends (only the latest).
 */
export function activityReporter(write: (a: StoredActivity) => unknown, o: { minMs?: number; now?: () => number } = {}) {
	const minMs = o.minMs ?? 1000, now = o.now ?? Date.now;
	let kind: ActivityKind | null = null, targets = new Set<string>();
	let written: string | null = null, lastWrite = -Infinity, timer: ReturnType<typeof setTimeout> | null = null, stopped = false;
	const current = (): StoredActivity | null => (kind ? { kind, n: Math.max(1, targets.size), at: now() } : null);
	const flush = () => {
		timer = null;
		const a = current();
		if (!a || stopped) return;
		const sig = `${a.kind}:${a.n}`;
		if (sig === written) return;
		written = sig; lastWrite = now();
		try { Promise.resolve(write(a)).catch(() => {}); } catch { /* best effort */ }
	};
	const schedule = () => {
		if (timer || stopped) return;
		const wait = lastWrite + minMs - now();
		if (wait <= 0) flush(); else timer = setTimeout(flush, wait);
	};
	const observe = (steps: ActivityStep[]) => {
		let changed = false;
		for (const s of steps) {
			if (s.kind === "think" && kind) continue;
			if (s.kind !== kind) { kind = s.kind; targets = new Set(); changed = true; }
			if (s.target && !targets.has(s.target)) { targets.add(s.target); changed = true; }
		}
		if (changed) schedule();
	};
	return {
		/** An adapter event (claude/codex). */
		event: (ev: AgentEvent) => observe(activityOf(ev)),
		/** A capcomd op the agent called (spawn, await, send, …), as seen by the daemon. */
		op: (op: string, target = "") => { const k = opKind(op); if (k) observe([step(k, target)]); },
		steps: observe,
		/** Stop: drop a pending write (the agent ended; its state change is the news now). */
		stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null; },
	};
}
export type ActivityReporter = ReturnType<typeof activityReporter>;
