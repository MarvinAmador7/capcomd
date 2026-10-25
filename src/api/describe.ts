// Plain-language text per step (envelope `text`): one short sentence a non-engineer can read, written by the daemon
// from trusted fields only (ids, types, statuses, numbers). Agent-written text never goes in here; it stays in `data`.
const who = (agentId: string | null) => (agentId ? `Agent ${agentId}` : "The run");

export function describeEvent(type: string, data: Record<string, unknown>, agentId: string | null): string {
	const a = who(agentId);
	const d = data as Record<string, any>;
	switch (type) {
		case "run.created": return "Run created.";
		case "run.granted": return "The run's budget was raised.";
		case "agent.spawned": return `${a} was started${d.parent ? ` by ${d.parent}` : ""}${d.profile ? ` as ${String(d.profile).toLowerCase()}` : ""}.`;
		case "agent.started": return `${a} began working.`;
		case "agent.done": return `${a} finished.`;
		case "agent.failed": return `${a} failed.`;
		case "agent.checkpointed": return `${a} saved a checkpoint (${Number(d.files) || 0} files).`;
		case "agent.notice_raised": return `${a} needs attention.`;
		case "agent.notice_cleared": return `${a} no longer needs attention.`;
		case "agent.paused": return `${a} paused.`;
		case "agent.resumed": return `${a} resumed.`;
		case "agent.granted": return `${a} got more budget.`;
		case "agent.adopted": return `Agent ${d.to} took over from ${d.from}.`;
		case "agent.reaped": return `${a} was stopped because its parent ${d.orphanOf} ended.`;
		case "agent.cancelled": return `${a} was cancelled.`;
		case "agent.status_changed": return `${a} is now ${d.status}.`;
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
		default: return type.replace(/[._]/g, " ") + ".";
	}
}
