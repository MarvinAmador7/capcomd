// The desktop page's sample run, taken from the approved Reel boards (apps/menubar/design/desktop/Reel.png on
// feat/desktop-shell): the matchkey migration, its crew in tree order, and what each column shows. Bot names come
// from the avatar engine (botName(seed)); the seeds were picked so the names match the boards.
import { botSvg, type Mood, type Size } from "./vendor/bot-avatar.js";

export type State = "working" | "asks" | "queued" | "waiting" | "merged";

export interface Line { kind: "text" | "tool" | "handoff" | "log" | "progress" | "diff" | "check"; [k: string]: unknown }

export interface Agent {
  id: string; role: "planner" | "lead" | "worker" | "critic"; seed: string; name: string; label: string;
  state: State; place: string; clock: string; thread: Line[];
}

export const RUN = { goal: "Migrate matchkey to v3.2", place: "Cloud · boxd eu-1 · 18:40" };

export const CREW: Agent[] = [
  {
    id: "planner", role: "planner", seed: "dk-98", name: "Loop", label: "planner", state: "working", place: "", clock: "18:40",
    thread: [
      { kind: "text", text: "Matchkey moves to v3.2 in three parts. ids/v1 goes to a lead with its own workers; nothing merges before the critic has read it." },
      { kind: "tool", icon: "doc", text: "Read the v3.2 migration notes", t: "0.6s" },
      { kind: "tool", icon: "spawn", text: "Spawned lead ids/v1 and the critic", t: "0.4s" },
      { kind: "text", text: "Waiting on ids/v1. The other two parts start once the join is fixed." },
    ],
  },
  {
    id: "lead", role: "lead", seed: "dk-47", name: "Nugget", label: "lead", state: "working", place: "ids/v1", clock: "14:02",
    thread: [
      { kind: "text", text: "I'll split ids/v1 across three workers: d3ce writes the shards, 4423 fixes the join, 9b1f takes over at shard 200 if d3ce stalls." },
      { kind: "tool", icon: "doc", text: "Read the ids/v1 schema", t: "0.4s" },
      { kind: "tool", icon: "spawn", text: "Spawned three workers", t: "0.9s" },
      { kind: "handoff", from: "worker 4423", text: "The join matched on raw email, so 4,812 rows fell through. Emails are normalised first now; the tests pass." },
      { kind: "text", text: "Good fix. I'm checking it against the nulls before it goes in." },
      { kind: "tool", icon: "term", text: "Running test/ids/join.test.ts", t: "0:12", live: true },
    ],
  },
  {
    id: "d3ce", role: "worker", seed: "dk-8", name: "Tinker", label: "d3ce", state: "working", place: "", clock: "6:15",
    thread: [
      { kind: "text", text: "Writing the v3.2 shards to r2://staging/mk, 256 in all." },
      { kind: "log", rows: [["21:48:05", "shard 115 written"], ["21:48:09", "shard 116 retry 1, model timeout", "warn"], ["21:48:14", "shard 116 written"], ["21:48:17", "shard 117 written"], ["21:48:20", "shard 118 written"]] },
      { kind: "progress", done: 118, of: 256 },
    ],
  },
  {
    id: "4423", role: "worker", seed: "dk-88", name: "Volt", label: "4423", state: "asks", place: "", clock: "9:31",
    thread: [
      { kind: "tool", icon: "term", text: "Ran test/ids/join.test.ts: 2 failed", t: "4.1s" },
      { kind: "tool", icon: "doc", text: "Read ids/v1/join_addriva_id.sql", t: "0.2s" },
      { kind: "text", text: "The join matched on raw email. I normalise both sides first, then join on email_norm." },
      { kind: "diff", file: "ids/v1/join_addriva_id.sql", add: 18, del: 3, rows: [[" ", "LEFT JOIN matchkey m"], ["-", "  ON m.email = i.email"], ["+", "  ON m.email_norm = lower(i.email)"], ["+", "  AND m.version = 'v3.2'"]] },
      { kind: "check", text: "Checks passed", t: "31 s" },
      { kind: "text", text: "Verified against the latest main. Ready to merge." },
    ],
  },
  {
    id: "9b1f", role: "worker", seed: "dk-41", name: "Radar", label: "9b1f", state: "queued", place: "", clock: "0:00",
    thread: [{ kind: "text", text: "Queued. I take over the shards at 200 if d3ce stalls." }],
  },
  {
    id: "critic", role: "critic", seed: "dk-201", name: "Mica", label: "critic", state: "waiting", place: "", clock: "2:48",
    thread: [
      { kind: "text", text: "Read-only. I review 4423's branch once it's verified against main." },
      { kind: "tool", icon: "doc", text: "Read ids/v1/join_addriva_id.sql", t: "0.2s" },
    ],
  },
];

export const ASK = { title: "Merge worker 4423's work into main?", sub: "3 files, +73 −5 · lead and planner wait on it" };

/** An agent's bot as an SVG string sized by CSS, hidden from assistive tech. */
export function bot(seed: string, role: string, size: Size, mood?: Mood): string {
  return botSvg({ seed, role, size, decorative: true, mood }).replace(/ width="\d+" height="\d+"/, "");
}

export const stateText: Record<State, string> = { working: "working", asks: "waiting on you", queued: "queued", waiting: "waiting", merged: "merged" };

/** Every keyboard shortcut in the desktop SPEC (§4) and the project menu, grouped as the page's tabs. */
export const KEYS: Array<{ tab: string; rows: Array<{ keys: string[]; title: string; note: string }> }> = [
  { tab: "Projects", rows: [
    { keys: ["⌘", "1–9"], title: "Open a project", note: "The decks are already in memory; the columns show at once." },
    { keys: ["⇧", "⌘", "N"], title: "Start a new project", note: "One empty column, the goal box and Lumen." },
    { keys: ["⌘", "L"], title: "Message the planner", note: "From anywhere in the project." },
    { keys: ["⌥", "⌘", "P"], title: "Pause or resume the run", note: "Agents stop at their next step, then carry on." },
    { keys: ["⌘", "T"], title: "Open the trace", note: "Every step the run recorded, in order." },
  ] },
  { tab: "Agents", rows: [
    { keys: ["⌃", "1–9"], title: "Jump to an agent", note: "In tree order: the planner first, then each lead and its workers." },
    { keys: ["⌃", "←"], title: "Focus the column on the left", note: "The reel moves only if that column would leave the window." },
    { keys: ["⌃", "→"], title: "Focus the column on the right", note: "Keyboard moves never animate beyond a short slide." },
  ] },
  { tab: "The reel", rows: [
    { keys: ["⌘", "0"], title: "Overview", note: "Every agent in the run as a card." },
    { keys: ["⇧", "⌘", "↩"], title: "Zoom one column", note: "The focused agent takes the whole window." },
    { keys: ["⌘", "K"], title: "Actions", note: "Everything the daemon can do to this run, searchable." },
  ] },
  { tab: "Decisions", rows: [
    { keys: ["↩"], title: "Approve the ask in focus", note: "The merge goes ahead and the agents waiting on it carry on." },
    { keys: ["esc"], title: "Close, never deny", note: "Denying is always a click on Deny, never a key you hit by accident." },
  ] },
];
