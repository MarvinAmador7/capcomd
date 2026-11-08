// Test plugin (tests/scenarios/triggers.test.ts): a trigger source the way the spec asks one to be (§16.3.1). It polls
// on its own timer (a plugin job, every second), reads the lines of the file CAPCOMD_TEST_TRIGGER_INBOX names after its
// read position, which it keeps in ctx.storage (a restart replays nothing), and for each: `{op: "emit", trigger}` hands
// the trigger to the intake; `{op: "subscribe", sub}` / `{op: "unsubscribe", sub}` make a run follow a thread or stop.
// It denies, at trigger.admitting, a trigger whose data says `policy: "deny"` (a team policy the allowlist can't say),
// and appends what each call answered, and every trigger.changed, to the file CAPCOMD_TEST_TRIGGER_LOG names. Its reply
// path (§16.3.7) "posts" a reply where the source reads: a line of its inbox carrying its mark, written by the user's
// own account (as a GitHub reply is), which its next read drops as its own words.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { definePlugin } from "../../../../packages/plugin/src/index";

/** What the fixture's own replies carry (as the GitHub source's `<!-- capcomd -->`). */
export const MARK = "<!-- capcomd -->";

export const plugin = definePlugin({
  activate(ctx) {
    const inbox = process.env.CAPCOMD_TEST_TRIGGER_INBOX, out = process.env.CAPCOMD_TEST_TRIGGER_LOG;
    const log = (x: Record<string, unknown>) => { if (out) appendFileSync(out, `${JSON.stringify(x)}\n`); };
    let busy = false;
    const poll = async () => {
      if (!inbox || !existsSync(inbox)) return;
      const lines = readFileSync(inbox, "utf8").split("\n").filter(Boolean);
      const pos = ((await ctx.storage.get("daemon", "pos")) as number | undefined) ?? 0;
      for (let i = pos; i < lines.length; i++) {
        const line = JSON.parse(lines[i]!) as { op: string; trigger?: { id: string; text: { text: string } }; sub?: never; tag?: string };
        try {
          // §16.3.1: a source drops its own words before emitting.
          if (line.op === "emit" && line.trigger!.text.text.includes(MARK)) log({ what: "dropped-own", tag: line.tag ?? null, id: line.trigger!.id });
          else if (line.op === "emit") log({ what: "emitted", tag: line.tag ?? null, decision: await ctx.triggers.emit(line.trigger as never) });
          else if (line.op === "subscribe") log({ what: "subscribed", tag: line.tag ?? null, sub: await ctx.triggers.subscribe(line.sub!) });
          else if (line.op === "unsubscribe") { await ctx.triggers.unsubscribe(line.sub!); log({ what: "unsubscribed", tag: line.tag ?? null }); }
        } catch (e) {
          log({ what: "error", tag: line.tag ?? null, code: (e as { code?: string }).code ?? null, message: String((e as Error)?.message ?? e) });
        }
        await ctx.storage.put("daemon", "pos", i + 1);
      }
    };
    ctx.hooks.on("job.changed", ({ payload: { job, change } }) => {
      if (job.plugin !== ctx.plugin.name || change.kind !== "fired" || busy) return;
      busy = true;
      void poll().catch((e) => log({ what: "poll-error", message: String((e as Error)?.message ?? e) })).finally(() => { busy = false; });
    });
    ctx.hooks.on("trigger.admitting", ({ payload }) => {
      log({ what: "admitting", id: payload.trigger.id, gate: payload.gate });
      return payload.trigger.data.policy === "deny" ? { decision: "deny", reason: "this team takes no triggers marked deny" } : { decision: "allow" };
    });
    ctx.hooks.on("trigger.changed", ({ payload }) => { log({ what: "changed", id: payload.trigger.id, decision: payload.decision }); });
    ctx.triggers.onReply("fixture", async (r) => {
      log({ what: "replied", reply: r });
      if (inbox) {
        const id = `reply-${r.runId}-${Date.now()}`;
        appendFileSync(inbox, `${JSON.stringify({ op: "emit", tag: id, trigger: { source: "fixture", id, thread: r.thread, at: new Date().toISOString(), actor: { id: "alice", display: "Alice", bot: false }, addressed: null, text: { text: `${r.text}\n\n${MARK}`, untrusted: true, by: "fixture" }, replyTo: null, data: {} } })}\n`);
      }
      return { url: `fixture:${r.thread}` };
    });
    void ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "poll the inbox", everyMs: 1000 }, { key: "poll" }).catch(() => {});
  },
});
