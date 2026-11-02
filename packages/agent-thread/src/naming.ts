// An agent naming its tab (capcomd agents.title): `capcomd title <words>` run by itself as a shell command, or the
// capcomd_title MCP tool. The daemon records such a call as the agent's title, and the thread and the step history
// leave it out (it is bookkeeping, not work); the raw logs and events keep it.
//
// A command counts only when it is exactly `capcomd title` and plain words: quoted or not, but no pipes, `&&`, `;`,
// redirections, substitutions, variables or globs. Anything else is something else, and is ignored (and shown).

/** The shell words of a plain command; null when it is more than one plain command (operators, expansions, globs). */
export function shellWords(command: string): string[] | null {
	const words: string[] = [];
	let cur = "", has = false, i = 0;
	const s = command.trim();
	while (i < s.length) {
		const c = s[i]!;
		if (c === " " || c === "\t") { if (has) { words.push(cur); cur = ""; has = false; } i++; continue; }
		if (c === "'") {
			const end = s.indexOf("'", i + 1);
			if (end < 0) return null;
			cur += s.slice(i + 1, end); has = true; i = end + 1; continue;
		}
		if (c === '"') {
			let j = i + 1;
			for (; j < s.length && s[j] !== '"'; j++) {
				const d = s[j]!;
				if (d === "$" || d === "`") return null;   // an expansion: not plain words
				if (d === "\\" && j + 1 < s.length && '"\\$`'.includes(s[j + 1]!)) { cur += s[++j]; continue; }
				cur += d;
			}
			if (j >= s.length) return null;
			has = true; i = j + 1; continue;
		}
		if (c === "\\") { if (i + 1 >= s.length || s[i + 1] === "\n") return null; cur += s[i + 1]; has = true; i += 2; continue; }
		// Operators, redirections, substitutions, variables, globs, comments, subshells, newlines.
		if ("|&;<>()$`*?[]{}~#!\n\r".includes(c)) return null;
		cur += c; has = true; i++;
	}
	if (has) words.push(cur);
	return words;
}

/** A plain command that is only `capcomd title …` (any form: yourself, a child, `--run`): its words after `title`; null
 *  for anything else. A shell wrapper (`bash -lc '…'`, as Codex runs commands) is looked through. */
function titleArgs(command: string): string[] | null {
	let w = shellWords(command);
	if (w && w.length === 3 && /^(\/(usr\/)?bin\/)?(ba|z)?sh$/.test(w[0]!) && /^-l?c$/.test(w[1]!)) w = shellWords(w[2]!);
	return w && w.length >= 3 && w[0] === "capcomd" && w[1] === "title" ? w.slice(2) : null;
}

/** The title an agent gives itself with a command that is only `capcomd title <words>`; null for anything else
 *  (naming a child or the run, other commands, a command with operators or expansions). */
export function namingCommand(command: string): string | null {
	const rest = titleArgs(command);
	if (!rest || rest.some((x) => x.startsWith("-")) || /^agt-/.test(rest[0]!)) return null;
	return rest.join(" ");
}

/** The capcomd_title MCP tool's name (Claude: mcp__capcomd__capcomd_title; Codex: server capcomd, tool capcomd_title). */
const NAMING_TOOL = /^(mcp__capcomd__)?capcomd_title$/;
const selfTitle = (a: Record<string, unknown>) => (typeof a.title === "string" && a.agent === undefined && a.run === undefined ? a.title : null);

/** A Claude tool_use by which the agent names its own tab: its title words, else null. */
export function claudeNaming(name: string, input: Record<string, unknown>): string | null {
	if (name === "Bash") return namingCommand(String(input.command ?? ""));
	return NAMING_TOOL.test(name) ? selfTitle(input) : null;
}

/** A Codex item by which the agent names its own tab (a command, or the MCP tool): its title words, else null. */
export function codexNaming(item: Record<string, any>): string | null {
	if (item.type === "command_execution") return namingCommand(String(item.command ?? ""));
	if (item.type === "mcp_tool_call" && item.server === "capcomd" && NAMING_TOOL.test(String(item.tool ?? ""))) return selfTitle(item.arguments && typeof item.arguments === "object" ? item.arguments : {});
	return null;
}

/** Any naming call (its own tab, a child's, the run's): bookkeeping the thread and the step history leave out. */
export function isClaudeNamingCall(name: string, input: Record<string, unknown>): boolean {
	return name === "Bash" ? titleArgs(String(input.command ?? "")) !== null : NAMING_TOOL.test(name);
}
export function isCodexNamingCall(item: Record<string, any>): boolean {
	if (item.type === "command_execution") return titleArgs(String(item.command ?? "")) !== null;
	return item.type === "mcp_tool_call" && item.server === "capcomd" && NAMING_TOOL.test(String(item.tool ?? ""));
}

/** Every naming call in one raw CLI event (Claude stream-json or Codex --json): its call id and title words. */
export function namingCalls(raw: unknown): Array<{ callId: string; title: string }> {
	const r = raw as any;
	const content = r?.message?.content;
	if (r?.type === "assistant" && Array.isArray(content)) {
		return content.flatMap((c: any) => {
			if (c?.type !== "tool_use") return [];
			const t = claudeNaming(String(c.name ?? ""), c.input && typeof c.input === "object" ? c.input : {});
			return t === null ? [] : [{ callId: String(c.id ?? ""), title: t }];
		});
	}
	const item = r?.item;
	if (typeof r?.type === "string" && /^item\.(started|updated|completed)$/.test(r.type) && item && typeof item === "object") {
		const t = codexNaming(item);
		return t === null ? [] : [{ callId: String(item.id ?? ""), title: t }];
	}
	return [];
}
