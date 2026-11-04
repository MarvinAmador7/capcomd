// The desktop page's sample run, taken from the approved Reel boards (apps/menubar/design/desktop/Reel.png on
// feat/desktop-shell): the matchkey migration, its crew in tree order, and what each column shows. Bot names come
// from the avatar engine (botName(seed)); the seeds were picked so the names match the boards.
import { botSvg, type Mood, type Size } from "./vendor/bot-avatar.js";

export type State = "working" | "asks" | "queued" | "waiting" | "merged" | "done";

export interface Line { kind: "text" | "tool" | "handoff" | "log" | "progress" | "diff" | "check"; [k: string]: unknown }

export interface Agent {
  id: string; role: "planner" | "lead" | "worker" | "critic"; seed: string; name: string; label: string;
  state: State; place: string; clock: string; thread: Line[];
}

// The run at the goal's finish (the goal-branch flow): every diff was reviewed and merged into the goal branch by
// the agents, and the planner presents the branch. Opening the pull request is the one decision left.
export const RUN = { goal: "Migrate matchkey to v3.2", place: "Cloud · boxd eu-1 · 18:40", branch: "migrate-matchkey-v3.2", base: "dev" };

export const CREW: Agent[] = [
  {
    id: "planner", role: "planner", seed: "dk-98", name: "Loop", label: "planner", state: "asks", place: "", clock: "18:40",
    thread: [
      { kind: "text", text: "Matchkey moves to v3.2. One lead takes ids/v1 with its workers; a critic reads every diff before it lands." },
      { kind: "tool", icon: "spawn", text: "Spawned lead ids/v1 and the critic", t: "0.4s" },
      { kind: "handoff", from: "lead ids/v1", text: "ids/v1 is merged: the join fix and all 256 shards, each approved by Mica." },
      { kind: "check", text: "Checks passed on migrate-matchkey-v3.2", t: "48 s" },
      { kind: "text", text: "The goal is done, and the branch is up to date with dev." },
    ],
  },
  {
    id: "lead", role: "lead", seed: "dk-47", name: "Nugget", label: "lead", state: "merged", place: "ids/v1", clock: "14:02",
    thread: [
      { kind: "text", text: "I'll split ids/v1 across three workers: d3ce writes the shards, 4423 fixes the join, 9b1f takes over at shard 200 if d3ce stalls." },
      { kind: "tool", icon: "spawn", text: "Spawned three workers", t: "0.9s" },
      { kind: "handoff", from: "worker 4423", text: "The join matched on raw email, so 4,812 rows fell through. Emails are normalised first now; the tests pass." },
      { kind: "check", text: "Mica approved the join fix", t: "1:52" },
      { kind: "check", text: "Mica approved the shards", t: "0:40" },
      { kind: "tool", icon: "branch", text: "Merged ids/v1 into migrate-matchkey-v3.2", t: "0.8s" },
    ],
  },
  {
    id: "d3ce", role: "worker", seed: "dk-8", name: "Tinker", label: "d3ce", state: "merged", place: "", clock: "11:20",
    thread: [
      { kind: "text", text: "Writing the v3.2 shards to r2://staging/mk, 256 in all." },
      { kind: "log", rows: [["21:58:32", "shard 253 written"], ["21:58:36", "shard 254 retry 1, model timeout", "warn"], ["21:58:41", "shard 254 written"], ["21:58:44", "shard 255 written"], ["21:58:47", "shard 256 written"]] },
      { kind: "progress", done: 256, of: 256 },
      { kind: "check", text: "Approved by Mica", t: "0:40" },
    ],
  },
  {
    id: "4423", role: "worker", seed: "dk-88", name: "Volt", label: "4423", state: "merged", place: "", clock: "9:31",
    thread: [
      { kind: "tool", icon: "term", text: "Ran test/ids/join.test.ts: 2 failed", t: "4.1s" },
      { kind: "tool", icon: "doc", text: "Read ids/v1/join_addriva_id.sql", t: "0.2s" },
      { kind: "text", text: "The join matched on raw email. I normalise both sides first, then join on email_norm." },
      { kind: "diff", file: "ids/v1/join_addriva_id.sql", add: 18, del: 3, rows: [[" ", "LEFT JOIN matchkey m"], ["-", "  ON m.email = i.email"], ["+", "  ON m.email_norm = lower(i.email)"], ["+", "  AND m.version = 'v3.2'"]] },
      { kind: "check", text: "Checks passed", t: "31 s" },
      { kind: "check", text: "Approved by Mica", t: "1:52" },
    ],
  },
  {
    id: "9b1f", role: "worker", seed: "dk-41", name: "Radar", label: "9b1f", state: "done", place: "", clock: "0:00",
    thread: [{ kind: "text", text: "Not needed: d3ce wrote all 256 shards without stalling." }],
  },
  {
    id: "critic", role: "critic", seed: "dk-201", name: "Mica", label: "critic", state: "done", place: "", clock: "4:12",
    thread: [
      { kind: "text", text: "Read-only. I review every diff in ids/v1 before the lead merges it." },
      { kind: "tool", icon: "doc", text: "Read ids/v1/join_addriva_id.sql", t: "0.2s" },
      { kind: "check", text: "Approved 4423's join fix", t: "1:52" },
      { kind: "check", text: "Approved d3ce's shards", t: "0:40" },
    ],
  },
];

export const ASK = { title: "Open a pull request from migrate-matchkey-v3.2?", sub: "Into dev · 9 files, +318 −41 · every diff reviewed" };

/** An agent's bot as an SVG string sized by CSS, hidden from assistive tech. */
export function bot(seed: string, role: string, size: Size, mood?: Mood): string {
  return botSvg({ seed, role, size, decorative: true, mood }).replace(/ width="\d+" height="\d+"/, "");
}

export const stateText: Record<State, string> = { working: "working", asks: "waiting on you", queued: "queued", waiting: "waiting", merged: "merged", done: "done" };
