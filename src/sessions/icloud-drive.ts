// The `icloud-drive` session store (ADR-026 §2, the owner's decision of 2026-11-19): a replica of the host's session
// objects as iCloud Drive files, `~/Library/Mobile Documents/com~apple~CloudDocs/capcomd/sessions/<key>.ccs`, sealed
// client-side (src/sessions/crypto.ts) before they are written. Any process can write there without entitlements
// (CloudKit needs the Apple Developer Program, which capcomd's ad hoc builds don't have).
//
// macOS may evict a file it has uploaded: before macOS 14 it is replaced by `.<name>.icloud`; since, it stays under its
// name and reading it downloads it. A read of an evicted file asks for it (`brctl download <path>`) and waits for it,
// up to `downloadTimeoutMs`. Off by default (`sessions.replica: "icloud-drive"` in ~/.capcomd/config.json turns it on);
// never needed while the host has its copy.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { checkSessionKey, type SessionStore } from "../../packages/plugin/src/session-store";
import { walk } from "./host";
import { loadOrCreateKey, replicaKeyFile, seal, unseal } from "./crypto";

/** iCloud Drive's own folder for this account (present when iCloud Drive is on). */
export const ICLOUD_DRIVE = () => join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
const EXT = ".ccs";

export interface IcloudDriveOptions {
  /** Where the objects go (default `<iCloud Drive>/capcomd/sessions`). Tests set a folder of their own. */
  root?: string;
  /** The encryption key's file (default `stateDir()/session-replica.key`). */
  keyFile?: string;
  /** How long a read waits for an evicted file (default 120 s). */
  downloadTimeoutMs?: number;
  /** Asks macOS to download an evicted file (default `brctl download <path>`, not waited on). */
  download?: (path: string) => void;
  pollMs?: number;
}

const brctlDownload = (path: string) => {
  try { spawn("brctl", ["download", path], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* polled anyway */ }
};

/** `.<name>.icloud`: what macOS (before 14) leaves in place of an evicted file. */
const placeholderOf = (file: string) => join(dirname(file), `.${basename(file)}.icloud`);

export function icloudDriveStore(o: IcloudDriveOptions = {}): SessionStore {
  const root = () => o.root ?? join(ICLOUD_DRIVE(), "capcomd", "sessions");
  let key: Buffer | null = null;
  const theKey = () => (key ??= loadOrCreateKey(o.keyFile ?? replicaKeyFile()));
  const fileOf = (k: string) => join(root(), k + EXT);
  return {
    describe: () => ({ name: "icloud-drive", label: "iCloud Drive", role: "replica", encrypted: true, where: root() }),
    async available() {
      if (o.root) return { ok: true };
      if (process.platform !== "darwin") return { ok: false, reason: "iCloud Drive is only on macOS", fix: "Set sessions.replica to null in ~/.capcomd/config.json." };
      if (!existsSync(ICLOUD_DRIVE())) return { ok: false, reason: "iCloud Drive isn't on for this account", fix: "Turn on iCloud Drive (System Settings › your name › iCloud › iCloud Drive), or set sessions.replica to null in ~/.capcomd/config.json." };
      return { ok: true };
    },
    async put(k, data) {
      checkSessionKey(k);
      const file = fileOf(k);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
      writeFileSync(tmp, seal(theKey(), k, data), { mode: 0o600 });
      renameSync(tmp, file);
      rmSync(placeholderOf(file), { force: true });
    },
    async get(k) {
      checkSessionKey(k);
      const file = fileOf(k), placeholder = placeholderOf(file);
      if (!existsSync(file) && !existsSync(placeholder)) return null;
      if (existsSync(placeholder)) {
        // Evicted: ask for it, then wait for the real file (the placeholder goes when it has come).
        (o.download ?? brctlDownload)(file);
        const end = Date.now() + (o.downloadTimeoutMs ?? 120_000);
        while (!(existsSync(file) && !existsSync(placeholder))) {
          if (Date.now() > end) throw new Error(`iCloud Drive hasn't downloaded ${file} yet (evicted from this Mac); try again once it has`);
          await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
        }
      }
      return unseal(theKey(), k, new Uint8Array(readFileSync(file)));
    },
    async list(prefix) {
      checkSessionKey(prefix, true);
      const r = root();
      const keys = new Set<string>();
      for (const rel of walk(r, join(r, prefix))) {
        const name = basename(rel), dir = rel.slice(0, rel.length - name.length);
        const evicted = /^\.(.+)\.icloud$/.exec(name);
        const real = evicted ? evicted[1]! : name;
        if (real.endsWith(EXT) && !real.startsWith(".")) keys.add(dir + real.slice(0, -EXT.length));
      }
      return [...keys].filter((k) => k.startsWith(prefix));
    },
    async delete(prefix) {
      checkSessionKey(prefix, true);
      if (!prefix.replace(/\/$/, "")) throw new Error("a session store delete names a run, an agent or an object, never everything");
      // A folder (a run's, an agent's) or one object, whichever the prefix names.
      const p = join(root(), prefix.replace(/\/$/, ""));
      rmSync(p, { recursive: true, force: true });
      rmSync(p + EXT, { force: true });
      rmSync(placeholderOf(p + EXT), { force: true });
    },
  };
}
