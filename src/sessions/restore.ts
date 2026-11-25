// ADR-026 §5 path 3: a saved CLI session put back on a fresh machine, where its CLI looks for it when it runs with
// HOME=`home` in `cwd` (the agent's stable checkout path): Claude Code's `<home>/.claude/projects/<slug of cwd>/<id>.jsonl`
// and its `<id>/` folder, codex's `<home>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` under its own name. The
// caller then runs the CLI with its provider's `session.resumeArgs(id)` (AgentTask.resumeSession) and the wake message
// as the first user turn; a CLI that still can't find it fails with SessionMissingError (src/agents/runner.ts).
import { dirname } from "node:path";
import type { SandboxProvider, VmId } from "../providers/sandbox";
import { agentSeam } from "../plugins/agents";
import { latestSession, readSession } from "./store";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Uploads the agent's latest saved session into machine `machineId`. Returns its id and CLI, or null when nothing was
 * saved, the stores can't give it back, its CLI's provider isn't active or keeps no sessions, or the upload failed
 * (the caller starts a fresh session then: path 4).
 */
export async function restoreSession(o: { runId: string; agentId: string; provider: SandboxProvider; machineId: VmId; home: string; cwd: string; onLog?: (lines: string[]) => void }): Promise<{ sessionId: string; cli: "claude" | "codex" } | null> {
  const log = (line: string) => { try { o.onLog?.([`[capcomd] ${line}`]); } catch { /* best effort */ } };
  try {
    const saved = await readSession(o.runId, o.agentId);
    if (!saved) return null;
    const { ref } = saved;
    const seam = agentSeam(ref.cli)?.session;
    if (!seam) { log(`session: ${ref.cli} isn't an active agent provider that keeps sessions, so the saved session ${ref.sessionId} isn't restored`); return null; }
    const at = seam.place({ home: o.home, cwd: o.cwd, id: ref.sessionId, file: ref.file });
    const files = [{ path: at.path, data: saved.file }, ...(at.folder ? saved.folder.map((f) => ({ path: `${at.folder}/${f.path}`, data: f.data })) : [])];
    // A provider's upload may not make folders (boxd's doesn't): made first, all at once.
    const dirs = [...new Set(files.map((f) => dirname(f.path)))];
    const mk = await o.provider.exec(o.machineId, ["sh", "-c", `mkdir -p ${dirs.map(q).join(" ")} && chmod 700 ${q(dirname(at.path))}`], { timeoutMs: 60_000 });
    if (mk.code !== 0) throw new Error(`mkdir failed: ${(mk.stderr || mk.stdout).trim().slice(-300)}`);
    for (const f of files) await o.provider.upload(o.machineId, f.path, f.data);
    // The whole file arrived (an upload cut short would resume a shorter conversation without a word).
    const wc = await o.provider.exec(o.machineId, ["sh", "-c", `wc -c < ${q(at.path)}`], { timeoutMs: 60_000 });
    if (wc.code !== 0 || Number(wc.stdout.trim()) !== saved.file.length) throw new Error(`the uploaded file has ${wc.stdout.trim() || "no"} bytes, not ${saved.file.length}`);
    log(`session: restored ${ref.cli} session ${ref.sessionId} (${saved.file.length} bytes${saved.folder.length ? `, ${saved.folder.length} files beside it` : ""}) to ${at.path}`);
    return { sessionId: ref.sessionId, cli: ref.cli };
  } catch (e) {
    log(`session: couldn't restore the saved session, so it starts a new one: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return null;
  }
}

/**
 * ADR-026 §5 path 2: the agent's parked machine was woken, so its CLI's session file is still where its CLI looks for
 * `cwd` (nothing to restore). Returns the latest saved session's id and CLI when its file is there and not empty (the
 * machine's own, unredacted, is never behind the host's copy); null otherwise (the caller restores it: path 3).
 */
export async function parkedSession(o: { runId: string; agentId: string; provider: SandboxProvider; machineId: VmId; home: string; cwd: string; onLog?: (lines: string[]) => void }): Promise<{ sessionId: string; cli: "claude" | "codex" } | null> {
  const log = (line: string) => { try { o.onLog?.([`[capcomd] ${line}`]); } catch { /* best effort */ } };
  try {
    const ref = await latestSession(o.runId, o.agentId);
    if (!ref) return null;
    const seam = agentSeam(ref.cli)?.session;
    if (!seam) return null;
    const at = seam.place({ home: o.home, cwd: o.cwd, id: ref.sessionId, file: ref.file });
    const wc = await o.provider.exec(o.machineId, ["sh", "-c", `[ -s ${q(at.path)} ] && wc -c < ${q(at.path)}`], { timeoutMs: 60_000 });
    const bytes = wc.code === 0 ? Number(wc.stdout.trim()) : 0;
    if (!(bytes > 0)) return null;
    log(`session: its parked machine still has ${ref.cli} session ${ref.sessionId} (${bytes} bytes): nothing to restore`);
    return { sessionId: ref.sessionId, cli: ref.cli };
  } catch {
    return null;
  }
}
