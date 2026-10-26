// Agent threads for the UI mock (harness #59 shape: GET …/agents/{agentId}/thread, agent.thread_item_changed frames).
// The panel scene's lead tells the story of thread-panel-v2.png; THREAD=golden serves the daemon's golden Claude session
// (packages/agent-thread/fixtures/golden) as the lead's thread instead, so every block type shows up.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Item = Record<string, any> & { id: string; rev: number; seq: number; order: number; agentId: string };

const t = (text: string) => ({ t: "text", text });
const code = (text: string) => ({ t: "code", text });
const p = (...children: any[]) => ({ t: "paragraph", children });
const file = (path: string) => ({ t: "link", text: path, href: null, target: "file", host: null, id: null, path, mismatch: false });
const none = (text: string) => ({ t: "link", text, href: null, target: "none", host: null, id: null, path: null, mismatch: false });
const list = (...items: any[][]) => ({ t: "list", ordered: false, start: null, items: items.map((children) => ({ checked: null, blocks: [p(...children)] })) });
const draft = (id: string, kind: string, atMs: number, text: string, blocks: any[], extra: Record<string, any> = {}) => ({
  id, rev: 1, kind, status: "done", at: new Date(atMs).toISOString(), durationMs: null, text, blocks, format: "blocks/1", redacted: false,
  tool: null, error: null, truncated: null, child: null, ...extra,
});
const tool = (id: string, atMs: number, kind: string, summary: string, ms: number, args: unknown, output: string) => draft(id, "tool", atMs, summary, [], {
  durationMs: ms, tool: { callId: `call-${id}`, name: kind === "read" ? "Read" : "Bash", kind, summary, isError: false, args: JSON.stringify(args).replace(/":/g, "\": "), output, files: [] },
});

/** The lead's thread in thread-panel-v2: the steer comes from snapshot.threads, everything else is thread items. */
export function leadThread(t0: number) {
  const s = 1000;
  return [
    draft("itm-ld-1", "say", t0 + 4 * s, "Got it. I’ll cap the backfill at shard 200 and point every worker at `r2://staging`.",
      [p(t("Got it. I’ll cap the backfill at shard 200 and point every worker at "), code("r2://staging"), t("."))]),
    draft("itm-ld-2", "thinking", t0 + 6 * s, "Shard writers are idle-bound…",
      [p(t("Shard writers are idle-bound on R2 PUTs, so three in parallel should be safe under the budget. The join key needs the normalized email or about 4% of rows miss."))]),
    draft("itm-ld-3", "say", t0 + 14 * s, "Plan …", [{ t: "heading", level: 3, children: [t("Plan")] },
      list([t("Normalize emails before the join")], [t("Fan out three workers on "), code("ids/v1")], [t("Validate nulls, then ask to merge")])]),
    tool("itm-ld-4", t0 + 15 * s, "read", "Read the ids/v1 schema", 400, { path: "ids/v1/schema.sql" },
      "CREATE TABLE ids (\n  id        BIGINT,\n  email     TEXT,\n  addriva_id TEXT  -- nullable\n);"),
    tool("itm-ld-5", t0 + 16 * s, "run", "Counted rows with duckdb", 2100, { command: "duckdb -c \"select count(*) from 'ids/v1/*.parquet'\"" }, "┌──────────┐\n│ 98412233 │\n└──────────┘"),
    tool("itm-ld-6", t0 + 19 * s, "spawn", "Spawned three workers", 900, { profile: "worker", count: 3 }, "agt-wk02, agt-wk03, agt-wk05"),
    draft("itm-ld-7", "handoff", t0 + 200 * s, "Wrote shards 1–118 to R2. Two shards needed a retry after a model timeout; both validated clean.",
      [p(t("Wrote shards 1–118 to R2. Two shards needed a retry after a model timeout; both validated clean.")),
       list([none("r2://matchkey/v3.2/")], [file("report.md")])],
      { child: { agentId: "agt-wk03", status: "done" } }),
    draft("itm-ld-8", "say", t0 + 205 * s, "The join was matching on raw email. Fixed: …", [p(t("The join was matching on raw email. Fixed:")),
      { t: "code", lang: "sql", truncatedLines: null, text: "SELECT shard, count(*) AS rows\nFROM read_parquet('r2://matchkey/v3.2/*.parquet')\nWHERE addriva_id IS NULL   -- must be 0\nGROUP BY shard LIMIT 5;" },
      { t: "table", align: [null, "right", null], header: [[t("Shard")], [t("Rows")], [t("Status")]], truncatedRows: null, truncatedCols: null,
        rows: [["116", "412k"], ["117", "409k"], ["118", "415k"]].map(([a, b]) => [[t(a)], [t(b)], [t("Written")]]) }]),
  ];
}

/** Every revision of the golden Claude session, as the daemon's store would number them. */
export function goldenThread() {
  const g = JSON.parse(readFileSync(join(import.meta.dir, "../../../../packages/agent-thread/fixtures/golden/claude-2.1.303.items.json"), "utf8"));
  return g.updates as any[];
}

/** Numbers drafts the way the daemon's thread store does: seq per write, order per new id. */
export class ThreadStore {
  items = new Map<string, Item[]>();   // agentId → every revision, in write order
  seq = 0;
  private order = new Map<string, number>();
  write(agentId: string, d: any): Item {
    const key = `${agentId}\0${d.id}`;
    if (!this.order.has(key)) this.order.set(key, [...this.order.keys()].filter((k) => k.startsWith(`${agentId}\0`)).length);
    const it = { ...d, seq: ++this.seq, order: this.order.get(key)!, agentId } as Item;
    this.items.set(agentId, [...(this.items.get(agentId) ?? []), it]);
    return it;
  }
  /** GET …/thread: latest rev of each item written after `after`, in write order. */
  page(agentId: string, after: number, limit: number) {
    const latest = new Map<string, Item>();
    for (const it of this.items.get(agentId) ?? []) if (it.seq > after) latest.set(it.id, it);
    const all = [...latest.values()].sort((a, b) => a.seq - b.seq);
    const items = all.slice(0, limit);
    return { items, next: all.length > limit ? items[items.length - 1].seq : null };
  }
}
