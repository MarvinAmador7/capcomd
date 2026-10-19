import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

/**
 * Merges are serialized per (remote, target branch). Two layers:
 *  - in-process: a promise chain per key;
 *  - cross-process on this host: an O_EXCL lock file holding {pid, starttime}. A lock whose
 *    owner is dead (SIGKILLed mid-merge) is stolen; starttime guards against PID reuse.
 * Across hosts, correctness comes from --force-with-lease / GitHub, not from this lock.
 */
const chains = new Map<string, Promise<unknown>>();

function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function alive(owner: { pid: number; start: string | null }): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (e: any) {
    if (e?.code === "ESRCH") return false;
  }
  const now = procStart(owner.pid);
  // No /proc (macOS): trust kill(0). With /proc: same pid must have the same start time.
  return now === null || owner.start === null || now === owner.start;
}

export function lockKey(remote: string, target: string): string {
  return createHash("sha1").update(`${remote}\0${target}`).digest("hex").slice(0, 16);
}

export async function withTargetLock<T>(lockDir: string, remote: string, target: string, fn: () => Promise<T>, timeoutMs = 15 * 60_000): Promise<T> {
  const key = lockKey(remote, target);
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  chains.set(key, prev.then(() => mine));
  await prev.catch(() => {});
  try {
    mkdirSync(lockDir, { recursive: true });
    const path = join(lockDir, `${key}.lock`);
    const me = JSON.stringify({ pid: process.pid, start: procStart(process.pid), target });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        writeFileSync(path, me, { flag: "wx" });
        break;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        let owner: any = null;
        try { owner = JSON.parse(readFileSync(path, "utf8")); } catch {}
        if (!owner || !alive(owner)) {
          try { unlinkSync(path); } catch {}
          continue;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for merge lock on ${target} (held by pid ${owner.pid})`);
        await Bun.sleep(50);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        if (readFileSync(path, "utf8") === me) unlinkSync(path);
      } catch {}
    }
  } finally {
    release();
  }
}
