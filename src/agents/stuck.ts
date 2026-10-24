// ADR-019 §2: stuck signals, read from what the agent does rather than from caps. Each has two windows: the first
// is a notice to the parent (the heuristics can be wrong, so it costs nothing), the second stops the agent with its
// work kept, when that stop is asked for (`stopIdle`, `stopRepeats`; by default only the notices). A long task that
// keeps doing different things never trips them.
import type { AgentEvent } from "./types";

export type StuckKind = "idle" | "spinning" | "failing";
export interface Stuck { kind: StuckKind; detail: string; stop: boolean }

/** Errors that differ only in numbers (times, line numbers, ids) are the same error. */
const errorSig = (call: string, error: string) => `${call}\n${error.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 300)}`;
const toolName = (call: string) => call.split(" ", 1)[0] ?? call;

export class StuckWatch {
  private lastEventAt: number;
  private call = "";
  private calls = 0;
  /** Per call+error: how many times it failed so far; that call succeeding clears it. */
  private fails = new Map<string, number>();
  /** The workspace as the supervisor last saw it (a tree hash), and when it last changed. */
  private tree: string | null = null;
  private changedAt: number;

  constructor(private o: { idleAfterMs: number; repeats: number; stopIdle: boolean; stopRepeats: boolean; noChangeAfterMs?: number }, now: number) {
    this.lastEventAt = now;
    this.changedAt = now;
  }

  /** The workspace's tree at a heartbeat (with noChangeAfterMs): a different one is progress. */
  observeTree(tree: string, now: number) {
    if (tree !== this.tree) { this.tree = tree; this.changedAt = now; }
  }

  observe(ev: AgentEvent, now: number) {
    this.lastEventAt = now;
    for (const c of ev.calls ?? []) {
      if (c === this.call) this.calls++;
      else { this.call = c; this.calls = 1; }
    }
    for (const r of ev.results ?? []) {
      if (r.error === undefined) { for (const k of [...this.fails.keys()]) if (k.startsWith(`${r.call}\n`)) this.fails.delete(k); continue; }
      const k = errorSig(r.call, r.error);
      this.fails.set(k, (this.fails.get(k) ?? 0) + 1);
      if (this.fails.size > 200) this.fails.delete(this.fails.keys().next().value!);
    }
  }

  /** Start every window again (a grant: the parent has seen the agent and lets it go on). */
  reset(now: number) {
    this.lastEventAt = now;
    this.call = "";
    this.calls = 0;
    this.fails.clear();
    this.changedAt = now;
  }

  /** The current signal, if any; `stop` once its second window has passed (and that stop is on). */
  check(now: number): Stuck | null {
    const { idleAfterMs, repeats, stopIdle, stopRepeats } = this.o;
    const quiet = now - this.lastEventAt;
    if (quiet > idleAfterMs) return { kind: "idle", detail: `no output from the agent for ${Math.round(quiet / 1000)}s`, stop: stopIdle && quiet > 2 * idleAfterMs };
    if (this.calls >= repeats) return { kind: "spinning", detail: `the same ${toolName(this.call)} call ${this.calls} times in a row`, stop: stopRepeats && this.calls >= 2 * repeats };
    let worst: [string, number] | null = null;
    for (const e of this.fails) if (!worst || e[1] > worst[1]) worst = e;
    if (worst && worst[1] >= repeats) {
      const [call, error] = worst[0].split("\n", 2) as [string, string];
      return { kind: "failing", detail: `the same ${toolName(call)} error ${worst[1]} times: ${error.slice(0, 120)}`, stop: stopRepeats && worst[1] >= 2 * repeats };
    }
    // Working (not idle: that came first) but changing nothing; opt-in, so its second window stops it.
    const still = now - this.changedAt;
    if (this.o.noChangeAfterMs && this.tree !== null && still > this.o.noChangeAfterMs)
      return { kind: "spinning", detail: `no change in the workspace for ${Math.round(still / 1000)}s while it works`, stop: still > 2 * this.o.noChangeAfterMs };
    return null;
  }
}
