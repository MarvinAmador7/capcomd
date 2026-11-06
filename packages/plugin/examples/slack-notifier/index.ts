// Worked example, spec §15.4: a third-party, out-of-process plugin. The host starts this process (§9.2); it opens a
// session, reads hook calls from the SSE stream and posts to Slack. Its token reads, and steers only to write its own
// `posted` event (events.emit needs steer, §11.1).
// `PluginClient` is the interface the client library implements (§9.8); `connect` makes one. Only node: APIs and the
// client library, so it runs on Bun or Node (docs/plugins.md says how to ship it with its dependency).
import { connect, sessionOpen, type HookFrame, type PluginClient, type ProcessEnvironment, type SessionOpened, type WireHookCall } from "@capcomd/plugin";

interface Config { channel: string; quiet: boolean }

/** What a hook payload becomes on Slack; null means "say nothing". Only daemon-written fields are used for the
 *  sentence; agent-written text (tasks, titles, reasons) is quoted as plain text, never as markup (§11.5). */
export function render(call: WireHookCall, cfg: Config): string | null {
  switch (call.hook) {
    case "run.changed": {
      const { run, change } = (call as WireHookCall<"run.changed">).payload;
      if (change.kind === "ended") return `Run ${run.id} ${change.state}${change.reason ? `: ${plain(change.reason)}` : ""}.`;
      if (change.kind === "started" && !cfg.quiet) return `Run ${run.id} started${run.title ? ` (${plain(run.title)})` : ""}.`;
      return null;
    }
    case "agent.changed": {
      const { agent, change } = (call as WireHookCall<"agent.changed">).payload;
      if (change.kind === "ended" && change.status === "failed") return `Agent ${agent.id} (${agent.profile ?? "no profile"}) failed in run ${agent.runId}.`;
      if (change.kind === "notice" && change.notice && change.notice.kind !== "idle") return `Agent ${agent.id} needs attention: ${change.notice.kind}.`;
      return null;
    }
    case "merge.changed": {
      const { merge, change } = (call as WireHookCall<"merge.changed">).payload;
      if (change.kind === "landed") return `Landed ${merge.ref} into ${merge.target} (${change.sha.slice(0, 7)}${change.pr ? `, PR #${change.pr}` : ""})${change.bypassedVetoes.length ? ` with ${change.bypassedVetoes.length} plugin veto(es) bypassed by the operator` : ""}.`;
      if (change.kind === "failed") return `Merge of ${merge.ref} into ${merge.target} failed: ${plain(change.reason)}.`;
      return null;
    }
    default:
      return null;
  }
}

/** Slack's mrkdwn treats `<`, `>` and `&` specially; agent text must not become links or mentions. */
const plain = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 300);

export async function main(client: PluginClient, env: ProcessEnvironment, signal: AbortSignal): Promise<void> {
  // The handshake (§9.3): this start's session, the hash of the manifest it was started from, its declared hooks.
  const session: SessionOpened = await client.open(sessionOpen(env));
  const cfg = session.config as unknown as Config;
  const webhook = session.secrets["webhook"];
  if (!webhook) throw new Error("the webhook secret is not configured (plugins.slack-notifier.webhook)");
  for await (const frame of client.hooks(signal)) await handle(frame, cfg, webhook, client);
}

async function handle(frame: HookFrame, cfg: Config, webhook: string, client: PluginClient): Promise<void> {
  if (frame.frame === "hook.dropped") { console.error(JSON.stringify({ level: "warn", message: "host dropped observe frames", count: frame.count })); return; }
  if (frame.frame === "session.closing") return;
  const text = render(frame.call, cfg);
  if (!text) return;
  // Observe calls need no answer; the deadline still bounds our work (§9.4). A failed post is logged, never retried
  // past the deadline: the next event carries the state anyway.
  const budget = Date.parse(frame.call.deadline) - Date.now();
  if (budget <= 0) return;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), budget);
  try {
    const res = await fetch(webhook, { method: "POST", signal: ac.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: cfg.channel, text }) });
    if (res.ok) await client.emit({ type: "posted", stream: frame.call.runId ?? "daemon", entity: frame.call.runId ?? "daemon", text: "Posted to Slack.", data: { hook: frame.call.hook, channel: cfg.channel } });
    else console.error(JSON.stringify({ level: "warn", message: "Slack refused the post", status: res.status }));
  } finally { clearTimeout(t); }
}

// The entry point: `connect` is the client library's constructor (§9.8); the environment is §9.2's.
if (import.meta.main) {
  const env = process.env as unknown as ProcessEnvironment;
  const ac = new AbortController();
  process.on("SIGTERM", () => ac.abort());
  main(connect(env), env, ac.signal).then(() => process.exit(0), (e) => { console.error(String(e)); process.exit(1); });
}
