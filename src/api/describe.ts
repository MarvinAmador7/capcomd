// Plain-language text per step (envelope `text`): one short sentence a non-engineer can read, written by the daemon
// from trusted fields only (ids, types, statuses, numbers). Agent-written text never goes in here; it stays in `data`.
const who = (agentId: string | null) => (agentId ? `Agent ${agentId}` : "The run");

export function describeEvent(type: string, data: Record<string, unknown>, agentId: string | null): string {
	const a = who(agentId);
	const d = data as Record<string, any>;
	switch (type) {
		case "run.created": return "Run created.";
		case "run.started": return "The run started.";
		case "run.paused": return "The run is paused: every working agent is paused.";
		case "run.resumed": return "The run resumed.";
		case "run.completed": return "The run finished: all agents are done.";
		case "run.failed": return "The run ended with a failed agent.";
		case "run.cancelled": return "The run was cancelled.";
		case "run.deleted": return "The run was deleted.";
		case "run.granted": return "The run's budget was raised.";
		case "run.ended": return d.state === "failed" ? "The run could not start." : "The run was cancelled.";
		case "agent.spawned": return `${a} was started${d.parent ? ` by ${d.parent}` : ""}${d.profile ? ` as ${String(d.profile).toLowerCase()}` : ""}.`;
		case "agent.started": return `${a} began working.`;
		case "agent.done": return `${a} finished.`;
		case "agent.failed": return `${a} failed.`;
		case "agent.checkpointed": return `${a} saved a checkpoint (${Number(d.files) || 0} files).`;
		case "agent.notice_raised": return `${a} needs attention.`;
		case "agent.notice_cleared": return `${a} no longer needs attention.`;
		// One finished step of the agent's history: the activity line in past tense ("Read 4 files", "Ran the tests").
		case "agent.step": return describeActivity(typeof d.kind === "string" ? d.kind : "tool", Number(d.n), true);
		case "agent.paused": return `${a} paused.`;
		case "agent.resumed": return `${a} resumed.`;
		case "agent.granted": return `${a} got more budget.`;
		case "agent.adopted": return `Agent ${d.to} took over from ${d.from}.`;
		case "agent.reaped": return `${a} was stopped because its parent ${d.orphanOf} ended.`;
		case "agent.cancelled": return `${a} was cancelled.`;
		case "agent.status_changed": return `${a} is now ${d.status}.`;
		// The server sets this event's text to the activity line itself (built from the stored kind and count).
		case "agent.activity_changed": return `${a} is ${d.status === "running" ? "working" : `now ${d.status ?? "idle"}`}.`;
		case "agent.thread_item_changed": return `${a}'s thread changed.`;
		case "deadlock.detected": return "Agents are waiting on each other; capcomd broke the deadlock.";
		case "drive.failed": return `${a} could not be driven (attempt ${Number(d.attempt) || 1}).`;
		case "token.revoked": return "An agent token was revoked.";
		case "message.sent": return `${a} sent a message to ${typeof d.to === "string" ? d.to : "agents"}.`;
		case "verify.started": return "Verification started.";
		case "verify.passed": return "Verification passed.";
		case "verify.failed": return "Verification failed.";
		case "merge.started": return "Merge started.";
		case "merge.succeeded": return "Merged.";
		case "merge.failed": return "The merge failed.";
		case "merge.approval_requested": return "A merge is waiting for your approval.";
		case "merge.approved": return "The merge was approved.";
		case "merge.denied": return "The merge was denied.";
		case "approval.requested": return `Waiting for your approval (${d.kind ?? "request"}).`;
		case "approval.decided": return `Approval ${d.status ?? "decided"}.`;
		case "task.added": return "A task was added.";
		case "task.claimed": return "A task was picked up.";
		case "task.lease_expired": return "A task timed out and is free again.";
		case "task.done": return "A task is done.";
		case "task.released": return "A task was released.";
		case "kv.put": case "kv.deleted": case "kv.swapped": return "A shared value changed.";
		case "sandbox.settings_changed": return "A place's setting was changed.";
		case "sandbox.resource_action": return "A machine was acted on from capcomd.";
		case "sandbox.resource_deleted": return "A machine was deleted.";
		case "project.configured": return "A project was set up.";
		case "project.git_initialized": return "A git repository was started in a folder.";
		case "project.published": return "A project was published to GitHub.";
		default: return type.replace(/[._]/g, " ") + ".";
	}
}

// Agent.activity / agent.activity_changed: what the agent is doing, from the daemon's fixed vocabulary plus a count
// (src/agents/activity.ts). Sentence case, no period; progressive while the agent works, past tense once it stopped.
// [now one, now many (# = count), done one, done many]
const ACTIVITY_TEXT: Record<string, [string, string, string, string]> = {
	read: ["Reading a file", "Reading # files", "Read a file", "Read # files"],
	edit: ["Editing a file", "Editing # files", "Edited a file", "Edited # files"],
	write: ["Writing a new file", "Writing # new files", "Wrote a new file", "Wrote # new files"],
	search: ["Searching the code", "Searching the code", "Searched the code", "Searched the code"],
	run: ["Running a command", "Running # commands", "Ran a command", "Ran # commands"],
	test: ["Running the tests", "Running the tests", "Ran the tests", "Ran the tests"],
	build: ["Building the project", "Building the project", "Built the project", "Built the project"],
	install: ["Installing dependencies", "Installing dependencies", "Installed dependencies", "Installed dependencies"],
	check: ["Checking the code", "Checking the code", "Checked the code", "Checked the code"],
	git: ["Looking at the changes", "Looking at the changes", "Looked at the changes", "Looked at the changes"],
	web: ["Looking something up online", "Looking things up online", "Looked something up online", "Looked things up online"],
	spawn: ["Starting a sub-agent", "Starting # sub-agents", "Started a sub-agent", "Started # sub-agents"],
	wait: ["Waiting for sub-agents", "Waiting for sub-agents", "Waited for sub-agents", "Waited for sub-agents"],
	message: ["Sending a message", "Sending # messages", "Sent a message", "Sent # messages"],
	verify: ["Verifying a change", "Verifying # changes", "Asked to verify a change", "Asked to verify # changes"],
	merge: ["Requesting a merge", "Requesting # merges", "Requested a merge", "Requested # merges"],
	report: ["Reporting back", "Reporting back", "Reported back", "Reported back"],
	delegate: ["Handing a step to a helper", "Handing # steps to helpers", "Handed a step to a helper", "Handed # steps to helpers"],
	plan: ["Planning the work", "Planning the work", "Planned the work", "Planned the work"],
	think: ["Thinking", "Thinking", "Thought it through", "Thought it through"],
	tool: ["Using a tool", "Using # tools", "Used a tool", "Used # tools"],
};

/** The activity line for a kind and count; `done` gives the past tense (the agent is no longer working). */
export function describeActivity(kind: string, n: number, done: boolean): string {
	const t = ACTIVITY_TEXT[kind] ?? ACTIVITY_TEXT.tool!;
	const count = Math.max(1, Math.floor(Number(n) || 1));
	return t[(done ? 2 : 0) + (count > 1 ? 1 : 0)]!.replace("#", String(count));
}

/** Agent.activity from what the scope actor stores ({kind, n, at}) and the agent's status. */
export function agentActivity(stored: { kind?: unknown; n?: unknown; at?: unknown } | null | undefined, status: string): { text: string; kind: string; at: string } | null {
	if (!stored || typeof stored.kind !== "string") return null;
	const kind = stored.kind in ACTIVITY_TEXT ? stored.kind : "tool";
	const at = Number(stored.at);
	return { text: describeActivity(kind, Number(stored.n), status !== "running" && status !== "pending"), kind, at: new Date(Number.isFinite(at) ? at : 0).toISOString() };
}
