// Client-side encryption for a session replica that leaves this Mac (ADR-026 §2): AES-256-GCM, a fresh 96-bit nonce per
// object, the object's key as associated data (an object copied under another key doesn't open). iCloud Drive's
// standard protection lets Apple hold the keys unless Advanced Data Protection is on, so nothing readable goes there.
//
// The key: 32 random bytes made once, kept in a 0600 file in capcomd's state folder (`stateDir()/session-replica.key`,
// base64), not the macOS Keychain. The daemon runs under launchd, often before anyone logs in (a FileVault Mac, a
// headless Mac mini), when the login keychain is locked; and the file sits beside the host's own copies of the sessions,
// which are the source of truth and aren't encrypted, so it gives a local reader nothing they couldn't read already.
// Recovery: the replica is only readable with this key. Copy the file to another Mac (same path under its capcomd home)
// to read the replica there; lose it and the replica is unreadable (the host copies are unaffected, and new objects are
// written under a new key). Each object names its key by an 8-byte fingerprint, so one sealed with another key fails
// with that said, not as corrupt data.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../utils/home";

const MAGIC = Buffer.from("CCS1");
const ID_BYTES = 8, IV_BYTES = 12, TAG_BYTES = 16;

export const replicaKeyFile = () => join(stateDir(), "session-replica.key");

/** The key in `file`, made (32 random bytes, the file 0600) when there is none. */
export function loadOrCreateKey(file = replicaKeyFile()): Buffer {
  if (existsSync(file)) {
    const k = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (k.length !== 32) throw new Error(`${file} isn't a session replica key (32 bytes, base64)`);
    return k;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const k = randomBytes(32);
  // wx: two processes making it at once keep the first one's.
  try { writeFileSync(file, k.toString("base64") + "\n", { mode: 0o600, flag: "wx" }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateKey(file);
    throw e;
  }
  return k;
}

const keyId = (key: Buffer) => createHash("sha256").update(key).digest().subarray(0, ID_BYTES);

/** `plain` sealed under `key`, bound to `aad` (the object's key): MAGIC, key fingerprint, nonce, tag, ciphertext. */
export function seal(key: Buffer, aad: string, plain: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([MAGIC, keyId(key), iv, c.getAuthTag(), body]));
}

/** What `seal` sealed; throws when it was sealed with another key, under another object key, or was changed. */
export function unseal(key: Buffer, aad: string, sealed: Uint8Array): Uint8Array {
  const b = Buffer.from(sealed);
  if (b.length < MAGIC.length + ID_BYTES + IV_BYTES + TAG_BYTES || !b.subarray(0, 4).equals(MAGIC)) throw new Error(`session object ${aad} isn't one capcomd sealed`);
  let at = 4;
  const id = b.subarray(at, (at += ID_BYTES));
  if (!id.equals(keyId(key))) throw new Error(`session object ${aad} was sealed with another key than ${replicaKeyFile()} (copy that Mac's key file here to read it)`);
  const iv = b.subarray(at, (at += IV_BYTES)), tag = b.subarray(at, (at += TAG_BYTES));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  try { return new Uint8Array(Buffer.concat([d.update(b.subarray(at)), d.final()])); } catch {
    throw new Error(`session object ${aad} doesn't open: changed, or stored under another name`);
  }
}
