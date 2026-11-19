// The session store seam (ADR-026 §2, the owner's decision of 2026-11-19): where a coding agent CLI's own session
// files are kept beyond the machine that ran it, as objects by key (put, get, list, delete). The kernel always keeps
// them on the host (the `host` store, the source of truth); one replica store at most (`sessions.replica` in the user
// config: `icloud-drive` first, an S3-compatible store and Vercel Blob later) gets a copy of every object, for other
// machines and for recovery, and is never needed for an agent to wake up while the host has its copy.
//
// Keys are `<run>/<agent>/…` paths (SESSION_KEY); the kernel writes each object once (a session grows by new segments,
// never by rewriting one) except `<run>/<agent>/ref.json`, the latest saved session's record. Objects are already
// compressed when the kernel puts them; a replica that leaves the host (iCloud Drive, a bucket) encrypts them itself.

/** What a store says of itself. `role`: `primary` is the host's (exactly one), `replica` a copy beside it. */
export interface SessionStoreDescriptor {
  name: string;
  label: string;
  role: "primary" | "replica";
  /** Objects are encrypted before they leave this machine (a replica off the host must). */
  encrypted: boolean;
  /** Where the objects are, for a person (a folder, a bucket). */
  where: string;
}

export interface SessionStore {
  describe(): SessionStoreDescriptor;
  /** Can it be used here now, and why not (no iCloud Drive on this Mac, no bucket credentials)? Cheap. */
  available(): Promise<{ ok: true } | { ok: false; reason: string; fix: string | null }>;
  /** Write `data` under `key`, replacing what was there; atomic (a reader sees the old object or the new one). */
  put(key: string, data: Uint8Array): Promise<void>;
  /** The object, or null when there is none. A store whose copies can be away (an evicted iCloud Drive file) waits for
   *  it to come back, up to its own deadline, and rejects when it doesn't. */
  get(key: string): Promise<Uint8Array | null>;
  /** The keys under `prefix` (a key's leading path segments, `run/agent/`), in no particular order. */
  list(prefix: string): Promise<string[]>;
  /** Delete the object `prefix` names, or every object under it (`run/`: a run's sessions). Idempotent. */
  delete(prefix: string): Promise<void>;
}

/** A session object's key: path segments of letters, digits, `.`, `_`, `@`, `+` and `-`, none of them `.` or `..`. */
export const SESSION_KEY = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/** Throws on a key (or a prefix, which may end in `/`) that isn't SESSION_KEY. */
export function checkSessionKey(key: string, prefix = false): string {
  const k = prefix && key.endsWith("/") ? key.slice(0, -1) : key;
  if ((prefix && k === "") || SESSION_KEY.test(k)) return key;
  throw new Error(`session store key ${JSON.stringify(key.slice(0, 120))} isn't a path of plain segments`);
}
