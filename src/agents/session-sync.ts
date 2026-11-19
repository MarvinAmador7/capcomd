// ADR-026 §2: the agent CLI's own session, copied out of its machine as it grows. The runner calls `step` once per
// look at the agent (its poll loop's drain: one call site), which reads what the CLI appended to its session file since
// the last look (by byte offset, complete lines only), passes every string in it through the runner's Redactor, and
// stores it gzipped as the next segment (src/sessions/store.ts). It looks every `everyMs` (15 s), and at once when a
// turn ended; the final look (the run over, before its machine is drained) also copies Claude Code's `<id>/` folder.
// Never fails the agent: what it can't save it says once in the agent's log.
import { gzipSync } from "node:zlib";
import type { AgentSession } from "../../packages/plugin/src/seams";
import type { ExecResult } from "../providers/sandbox";
import { SECRET_KEY, type Redactor } from "./redact";
import { SESSION_KEY } from "../../packages/plugin/src/session-store";
import { folderKey, putSessionObject, recordSession, savedSession, segmentKey, type SavedSession } from "../sessions/store";

/** How often the session file is looked at while the agent works (CAPCOMD_SESSION_SYNC_MS). */
export const SESSION_SYNC_MS = () => Number(process.env.CAPCOMD_SESSION_SYNC_MS ?? 15_000);
/** Bytes read from the machine at a time; a line longer than this is read whole in a bigger piece. */
const CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 512 * 1024 * 1024;

/** A string value under a key that names a credential, somewhere in a JSON line (SECRET_KEY's names). */
const SECRET_FIELD = new RegExp(`"[^"]*(?:${SECRET_KEY.source})[^"]*"\\s*:\\s*"`, "i");

/**
 * One line of a session file, redacted: every string through the Redactor and a credential-named key's string value
 * replaced whole (`Redactor.value`, the kernel's rule), when the line has anything to redact; else the line as it was
 * (byte for byte: most lines). A line that isn't JSON is redacted as text.
 */
export function redactSessionLine(line: string, r: Redactor): string {
  if (!r.contains(line) && !SECRET_FIELD.test(line)) return line;
  try { return JSON.stringify(r.value(JSON.parse(line))); } catch { return r.text(line); }
}

/** A file's text redacted line by line (a `.jsonl`), or as text; bytes that aren't UTF-8 text are kept as they are. */
export function redactSessionBytes(data: Uint8Array, r: Redactor, jsonl: boolean): Uint8Array {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return data; }
  const out = jsonl ? text.split("\n").map((l) => (l ? redactSessionLine(l, r) : l)).join("\n") : r.text(text);
  return out === text ? data : new TextEncoder().encode(out);
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface SessionSyncOptions {
  runId: string;
  agentId: string;
  /** The provider's session support, and its name (`claude`, `codex`): SessionRef.cli. */
  session: AgentSession & { cli: string };
  /** A shell script in the machine (the runner's `sh`). */
  sh: (script: string) => Promise<ExecResult>;
  /** A file from the machine, as bytes. */
  download: (path: string) => Promise<Uint8Array>;
  redactor: Redactor;
  home: string;
  cwd: string;
  /** A folder of the attempt's in the machine, for the piece being read. */
  scratch: string;
  now?: () => number;
  everyMs?: number;
  onLog?: (lines: string[]) => void;
}

export class SessionSync {
  private id: string | null = null;
  private path: string | null = null;
  /** Bytes of the machine's file already saved (or already there when the run started). */
  private offset = 0;
  private rec: SavedSession | null = null;
  private lastAt = -Infinity;
  private chunk = CHUNK;
  private said = new Set<string>();
  private busy: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly o: SessionSyncOptions) { this.now = o.now ?? Date.now; }

  /** The session saved so far (its record), or null before the first save. */
  get saved(): SavedSession | null { return this.rec; }

  private log(key: string, line: string) {
    if (this.said.has(key)) return;
    this.said.add(key);
    try { this.o.onLog?.([`[capcomd] session: ${line}`]); } catch { /* best effort */ }
  }

  /**
   * Before the CLI starts. `id`: the session it runs (null for a CLI that names its own: its id comes to `step`);
   * `resume`: it continues a session already in the machine (restored, or kept on a parked machine), whose content up
   * to now was saved before: only what it appends is new, after the segments saved so far.
   */
  async begin(id: string | null, resume: boolean): Promise<void> {
    this.id = id;
    if (!resume || !id) return;
    try {
      const prev = await savedSession(this.o.runId, this.o.agentId);
      if (prev && prev.sessionId === id) this.rec = prev;
      const at = await this.locate();
      if (at) { this.path = at.path; this.offset = at.size; }
    } catch (e) { this.log("begin", `couldn't look at the session it resumes: ${this.errText(e)}`); }
  }

  /** The poll loop's one call: after each look at the agent. `final`: the run is over (its CLI stopped). */
  step(o: { final: boolean; turnEnded?: boolean; sessionId?: string }): Promise<void> {
    // One at a time, in order: a final step waits for one still running.
    const run = this.busy.then(() => this.stepNow(o));
    this.busy = run.catch(() => {});
    return run.catch((e) => this.log(`step:${String((e as Error)?.message ?? e).slice(0, 60)}`, `couldn't save the session: ${this.errText(e)}`));
  }

  private errText(e: unknown) { return this.o.redactor.text(String((e as Error)?.message ?? e)).slice(0, 300); }

  private async locate(): Promise<{ path: string; size: number } | null> {
    if (!this.id) return null;
    const find = this.path ? `printf '%s\\n' ${q(this.path)}` : this.o.session.locate({ home: this.o.home, cwd: this.o.cwd, id: this.id }, q);
    const res = await this.o.sh(`f=$(${find}); [ -n "$f" ] && [ -f "$f" ] || exit 0; printf '%s\\n' "$f"; wc -c < "$f"`);
    const [path, size] = res.stdout.split("\n").map((s) => s.trim());
    return path && size && /^\d+$/.test(size) ? { path, size: Number(size) } : null;
  }

  private async stepNow(o: { final: boolean; turnEnded?: boolean; sessionId?: string }): Promise<void> {
    // The CLI says which session it writes (Claude Code's init, codex's thread.started): a CLI that forked the session
    // it resumed into a new id wrote the whole conversation into the new file, which is saved from its start.
    if (o.sessionId && o.sessionId !== this.id) {
      if (this.id) this.log(`fork:${o.sessionId}`, `the CLI continues session ${this.id} as ${o.sessionId}; saving that one`);
      this.id = o.sessionId; this.path = null; this.offset = 0;
    }
    if (!this.id) return;
    if (!o.final && !o.turnEnded && this.now() - this.lastAt < (this.o.everyMs ?? SESSION_SYNC_MS())) return;
    this.lastAt = this.now();
    // Until the file is there and has grown: a few reads of at most `chunk` bytes, complete lines only.
    let cutAny = false;
    for (let reads = 0; reads < (o.final ? 10_000 : 16); reads++) {
      const at = await this.locate();
      if (!at) break;
      this.path = at.path;
      if (at.size < this.offset) { this.log("shrank", `${at.path} is shorter than what was saved of it (${at.size} < ${this.offset} bytes); the saved copy is kept as it was`); break; }
      if (at.size === this.offset) break;
      const piece = `${this.o.scratch}/session.piece`, size = this.chunk;
      cutAny = true;
      const cut = await this.o.sh(`tail -c +${this.offset + 1} ${q(at.path)} | head -c ${size} > ${q(piece)}`);
      if (cut.code !== 0) throw new Error(`reading ${at.path} failed: ${(cut.stderr || cut.stdout).trim().slice(-200)}`);
      const data = await this.o.download(piece);
      const nl = data.lastIndexOf(10);
      if (nl < 0) {
        // A line longer than a piece: read it whole next time (up to MAX_LINE), unless it is still being written.
        if (data.length >= size && size < MAX_LINE) { this.chunk = Math.min(MAX_LINE, size * 4); continue; }
        break;
      }
      await this.saveLines(data.subarray(0, nl + 1));
      this.offset += nl + 1;
      this.chunk = CHUNK;
      // All there was (what's left is a line still being written): the next look reads on.
      if (data.length < size) break;
    }
    if (cutAny) await this.o.sh(`rm -f ${q(`${this.o.scratch}/session.piece`)}`).catch(() => {});
    // The rest of a line the CLI didn't finish (it was stopped mid-write) isn't kept: half a JSON line resumes nothing.
    if (o.final) await this.saveFolder().catch((e) => this.log("folder", `couldn't save the files beside the session: ${this.errText(e)}`));
  }

  private async saveLines(bytes: Uint8Array): Promise<void> {
    const out = redactSessionBytes(bytes, this.o.redactor, true);
    const prev = this.rec;
    const n = (prev?.sessionId === this.id ? prev.segments : 0) + 1;
    await putSessionObject(segmentKey(this.o.runId, this.o.agentId, this.id!, n), gzipSync(out));
    const name = this.path!.slice(this.path!.lastIndexOf("/") + 1);
    this.rec = {
      cli: this.o.session.cli as SavedSession["cli"], sessionId: this.id!, file: name,
      bytes: (prev?.sessionId === this.id ? prev.bytes : 0) + out.length, savedAt: this.now(), segments: n,
      ...(prev?.sessionId === this.id && prev.folder ? { folder: prev.folder } : {}),
    };
    await recordSession(this.o.runId, this.o.agentId, this.rec);
  }

  /** The CLI's folder beside its session file (Claude Code's `<id>/`), each file whose size changed. */
  private async saveFolder(): Promise<void> {
    if (!this.path || !this.rec || !this.id) return;
    const placed = this.o.session.place({ home: this.o.home, cwd: this.o.cwd, id: this.id, file: this.rec.file });
    if (!placed.folder) return;
    const dir = `${this.path.slice(0, this.path.lastIndexOf("/"))}/${this.id}`;
    const ls = await this.o.sh(`cd ${q(dir)} 2>/dev/null || exit 0; find . -type f | while IFS= read -r f; do printf '%s %s\\n' "$(wc -c < "$f" | tr -d ' ')" "\${f#./}"; done`);
    const folder = { ...(this.rec.folder ?? {}) };
    let changed = false;
    for (const line of ls.stdout.split("\n")) {
      const m = /^(\d+) (.+)$/.exec(line.trim());
      if (!m) continue;
      const size = Number(m[1]), rel = m[2]!;
      if (folder[rel] === size) continue;
      if (!SESSION_KEY.test(rel)) { this.log(`name:${rel}`, `${rel} beside the session has a name the store doesn't take; not saved`); continue; }
      const data = redactSessionBytes(await this.o.download(`${dir}/${rel}`), this.o.redactor, rel.endsWith(".jsonl"));
      await putSessionObject(folderKey(this.o.runId, this.o.agentId, this.id, rel), gzipSync(data));
      folder[rel] = size;
      changed = true;
    }
    if (changed) {
      this.rec = { ...this.rec, folder, savedAt: this.now() };
      await recordSession(this.o.runId, this.o.agentId, this.rec);
    }
  }
}
