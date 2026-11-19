// ADR-026 §2: the session stores (host, iCloud Drive with client-side encryption), the records, the redaction of a
// session file and where each CLI keeps its sessions. The iCloud Drive store runs on a folder of the test's own: never
// the real iCloud Drive.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import { hostSessionStore } from "../../src/sessions/host";
import { icloudDriveStore } from "../../src/sessions/icloud-drive";
import { loadOrCreateKey, seal, unseal } from "../../src/sessions/crypto";
import { deleteRunSessions, latestSession, putSessionObject, readSession, recordSession, replicaIdle, replicaName, segmentKey, useSessionStores } from "../../src/sessions/store";
import { redactSessionBytes, redactSessionLine } from "../../src/agents/session-sync";
import { Redactor, REDACTED } from "../../src/agents/redact";
import { CLAUDE_SESSION, claudeProjectSlug } from "../../src/plugins/agent-claude";
import { CODEX_SESSION, codexRolloutDay } from "../../src/plugins/agent-codex";
import { checkSessionKey } from "../../packages/plugin/src/session-store";

const made: string[] = [];
const tmp = (n: string) => { const d = mkdtempSync(join(tmpdir(), `capcomd-sessions-${n}-`)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const mode = (p: string) => statSync(p).mode & 0o777;
afterEach(() => useSessionStores(null));

describe("host store", () => {
  test("put, get, list and delete by key; folders 0700, files 0600", async () => {
    const root = join(tmp("host"), "sessions");
    const s = hostSessionStore(root);
    expect(s.describe()).toMatchObject({ name: "host", role: "primary", encrypted: false });
    await s.put("run-1/agt-1/ref.json", enc("{}"));
    await s.put("run-1/agt-1/sid/file/000001.gz", enc("a"));
    await s.put("run-1/agt-2/ref.json", enc("{}"));
    expect(dec(await s.get("run-1/agt-1/sid/file/000001.gz"))).toBe("a");
    expect(await s.get("run-1/agt-1/nope")).toBeNull();
    expect((await s.list("run-1/agt-1/")).sort()).toEqual(["run-1/agt-1/ref.json", "run-1/agt-1/sid/file/000001.gz"]);
    expect(mode(join(root, "run-1/agt-1/ref.json"))).toBe(0o600);
    for (const d of [root, join(root, "run-1"), join(root, "run-1/agt-1"), join(root, "run-1/agt-1/sid/file")]) expect(mode(d)).toBe(0o700);
    await s.delete("run-1/agt-1/");
    expect(await s.list("run-1/")).toEqual(["run-1/agt-2/ref.json"]);
    await s.delete("run-1/");
    expect(existsSync(join(root, "run-1"))).toBe(false);
    await expect(s.delete("")).rejects.toThrow();
  });

  test("keys are plain paths: no .., no leading slash, no empty segment", () => {
    for (const bad of ["../x", "a/../b", "/abs", "a//b", "a/./b", "a b", ""]) expect(() => checkSessionKey(bad)).toThrow();
    for (const ok of ["run-1/agt-1/ref.json", "r/a/0199-uuid/folder/subagents/agent-a1.jsonl", "r/a/x/folder/tool-results/toolu_01@x+y.txt"]) expect(checkSessionKey(ok)).toBe(ok);
    expect(checkSessionKey("run-1/", true)).toBe("run-1/");
  });
});

describe("encryption (AES-256-GCM, a key file made once)", () => {
  test("seals and opens; bound to the object's key; another key says so", () => {
    const dir = tmp("key");
    const file = join(dir, "state", "session-replica.key");
    const k = loadOrCreateKey(file);
    expect(k.length).toBe(32);
    expect(mode(file)).toBe(0o600);
    expect(loadOrCreateKey(file).equals(k)).toBe(true);
    const sealed = seal(k, "run/agt/ref.json", enc("secret session"));
    expect(Buffer.from(sealed).includes(Buffer.from("secret session"))).toBe(false);
    expect(dec(unseal(k, "run/agt/ref.json", sealed))).toBe("secret session");
    expect(() => unseal(k, "run/other/ref.json", sealed)).toThrow(/doesn't open/);
    const other = loadOrCreateKey(join(dir, "other.key"));
    expect(() => unseal(other, "run/agt/ref.json", sealed)).toThrow(/another key/);
    const changed = new Uint8Array(sealed); changed[changed.length - 1]! ^= 1;
    expect(() => unseal(k, "run/agt/ref.json", changed)).toThrow(/doesn't open/);
  });
});

describe("iCloud Drive store (a test folder, never the real one)", () => {
  test("writes sealed .ccs files, reads them back, lists and deletes", async () => {
    const dir = tmp("icloud");
    const s = icloudDriveStore({ root: join(dir, "drive"), keyFile: join(dir, "k.key") });
    expect(s.describe()).toMatchObject({ name: "icloud-drive", role: "replica", encrypted: true });
    expect(await s.available()).toEqual({ ok: true });
    await s.put("run-1/agt-1/ref.json", enc('{"plain":"text"}'));
    const file = join(dir, "drive", "run-1/agt-1/ref.json.ccs");
    expect(readFileSync(file).includes(Buffer.from("plain"))).toBe(false);
    expect(mode(file)).toBe(0o600);
    expect(dec(await s.get("run-1/agt-1/ref.json"))).toBe('{"plain":"text"}');
    expect(await s.get("run-1/agt-1/none")).toBeNull();
    expect(await s.list("run-1/")).toEqual(["run-1/agt-1/ref.json"]);
    await s.delete("run-1/");
    expect(await s.list("run-1/")).toEqual([]);
  });

  test("an evicted file (.<name>.icloud) is downloaded and waited for; one that never comes fails the read", async () => {
    const dir = tmp("evict");
    const root = join(dir, "drive");
    const asked: string[] = [];
    const s = icloudDriveStore({ root, keyFile: join(dir, "k.key"), pollMs: 20, downloadTimeoutMs: 2000, download: (p) => {
      asked.push(p);
      // iCloud brings it back a little later: the real file, and the placeholder gone.
      setTimeout(() => { writeFileSync(p, held); rmSync(join(root, "run-1/agt-1/.seg.gz.ccs.icloud")); }, 150);
    } });
    await s.put("run-1/agt-1/seg.gz", enc("segment"));
    const real = join(root, "run-1/agt-1/seg.gz.ccs");
    const held = readFileSync(real);
    rmSync(real);
    writeFileSync(join(root, "run-1/agt-1/.seg.gz.ccs.icloud"), "placeholder");
    expect(await s.list("run-1/agt-1/")).toEqual(["run-1/agt-1/seg.gz"]);
    expect(dec(await s.get("run-1/agt-1/seg.gz"))).toBe("segment");
    expect(asked).toEqual([real]);

    const never = icloudDriveStore({ root, keyFile: join(dir, "k.key"), pollMs: 20, downloadTimeoutMs: 200, download: () => {} });
    writeFileSync(join(root, "run-1/agt-1/.gone.ccs.icloud"), "placeholder");
    await expect(never.get("run-1/agt-1/gone")).rejects.toThrow(/hasn't downloaded/);
  });
});

describe("records and reads across the stores", () => {
  const stores = () => {
    const dir = tmp("stores");
    const primary = hostSessionStore(join(dir, "host"));
    const replica = icloudDriveStore({ root: join(dir, "drive"), keyFile: join(dir, "k.key") });
    useSessionStores({ primary, replica });
    return { dir, primary, replica };
  };

  test("recordSession/latestSession; every object reaches the replica too", async () => {
    const { primary, replica } = stores();
    expect(await latestSession("run-1", "agt-1")).toBeNull();
    await putSessionObject(segmentKey("run-1", "agt-1", "sid-1", 1), gzipSync(enc('{"a":1}\n')));
    await recordSession("run-1", "agt-1", { cli: "claude", sessionId: "sid-1", file: "sid-1.jsonl", bytes: 8, savedAt: 1000, segments: 1 });
    expect(await latestSession("run-1", "agt-1")).toEqual({ cli: "claude", sessionId: "sid-1", file: "sid-1.jsonl", bytes: 8, savedAt: 1000 });
    await replicaIdle();
    expect((await replica.list("run-1/")).sort()).toEqual((await primary.list("run-1/")).sort());
    const read = await readSession("run-1", "agt-1");
    expect(dec(read!.file)).toBe('{"a":1}\n');
  });

  test("the host copy wins; with none (another Mac, lost state) the replica gives it back; delete takes both", async () => {
    const { primary, replica } = stores();
    await putSessionObject(segmentKey("run-2", "agt-1", "sid-1", 1), gzipSync(enc("one\n")));
    await putSessionObject(segmentKey("run-2", "agt-1", "sid-1", 2), gzipSync(enc("two\n")));
    await recordSession("run-2", "agt-1", { cli: "codex", sessionId: "sid-1", file: "rollout-2026-11-19T10-00-00-sid-1.jsonl", bytes: 8, savedAt: 1, segments: 2 });
    await replicaIdle();
    // The host's record differs from the replica's: the host's is read.
    await primary.put("run-2/agt-1/ref.json", enc(JSON.stringify({ cli: "codex", sessionId: "sid-1", file: "f.jsonl", bytes: 4, savedAt: 2, segments: 1 })));
    expect(dec((await readSession("run-2", "agt-1"))!.file)).toBe("one\n");
    await primary.delete("run-2/");
    const back = await readSession("run-2", "agt-1");
    expect(back!.ref.file).toBe("rollout-2026-11-19T10-00-00-sid-1.jsonl");
    expect(dec(back!.file)).toBe("one\ntwo\n");
    await deleteRunSessions("run-2");
    expect(await replica.list("run-2/")).toEqual([]);
    expect(await readSession("run-2", "agt-1")).toBeNull();
  });

  test("the replica is off unless chosen (CAPCOMD_SESSIONS_REPLICA, else sessions.replica in the user config)", () => {
    const home = tmp("cfg");
    expect(replicaName({ CAPCOMD_HOME: home })).toBeNull();
    writeFileSync(join(home, "config.json"), JSON.stringify({ sessions: { replica: "icloud-drive" } }));
    expect(replicaName({ CAPCOMD_HOME: home })).toBe("icloud-drive");
    expect(replicaName({ CAPCOMD_HOME: home, CAPCOMD_SESSIONS_REPLICA: "none" })).toBeNull();
    writeFileSync(join(home, "config.json"), JSON.stringify({ sessions: { replica: null } }));
    expect(replicaName({ CAPCOMD_HOME: home })).toBeNull();
  });
});

describe("redaction of a session file", () => {
  const r = new Redactor(["sk-ant-api03-SECRETVALUE-0123456789"]);
  test("a line with nothing to redact is kept byte for byte", () => {
    const line = '{"type":"assistant","message":{"usage":{"input_tokens":12,"output_tokens":3},"content":"hi"}}';
    expect(redactSessionLine(line, r)).toBe(line);
  });
  test("a known secret, a token shape and a credential-named key's string are replaced; the JSON stays JSON", () => {
    const out = redactSessionLine('{"toolUseResult":{"stdout":"key sk-ant-api03-SECRETVALUE-0123456789 and ghp_abcdefghijklmnopqrstuvwxyz0123"},"auth":{"token":"plain"},"usage":{"input_tokens":5}}', r);
    const v = JSON.parse(out);
    expect(v.toolUseResult.stdout).toBe(`key ${REDACTED} and ${REDACTED}`);
    expect(v.auth.token).toBe(REDACTED);
    expect(v.usage.input_tokens).toBe(5);
  });
  test("a line that isn't JSON is redacted as text; bytes that aren't text are kept", () => {
    expect(redactSessionLine("not json sk-ant-api03-SECRETVALUE-0123456789", r)).toBe(`not json ${REDACTED}`);
    const bin = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    expect(redactSessionBytes(bin, r, true)).toBe(bin);
    expect(dec(redactSessionBytes(enc('{"a":"sk-ant-api03-SECRETVALUE-0123456789"}\n{"b":1}\n'), r, true))).toBe(`{"a":"${REDACTED}"}\n{"b":1}\n`);
  });
});

describe("where each CLI keeps a session", () => {
  test("Claude Code: projects/<slug of cwd>/<id>.jsonl and its <id>/ folder; a missing id is detected", () => {
    expect(claudeProjectSlug("/vm/agt-1.x/repo")).toBe("-vm-agt-1-x-repo");
    expect(CLAUDE_SESSION.place({ home: "/vm/home", cwd: "/vm/agt-1/repo", id: "u1", file: "u1.jsonl" })).toEqual({ path: "/vm/home/.claude/projects/-vm-agt-1-repo/u1.jsonl", folder: "/vm/home/.claude/projects/-vm-agt-1-repo/u1" });
    expect(CLAUDE_SESSION.firstRunArgs("u1")).toEqual(["--session-id", "u1"]);
    expect(CLAUDE_SESSION.resumeArgs("u1")).toEqual(["--resume", "u1"]);
    expect(CLAUDE_SESSION.detectMissing("No conversation found with session ID: u1")).toBe(true);
    expect(CLAUDE_SESSION.detectMissing("Error: rate limited")).toBe(false);
  });
  test("codex: sessions/YYYY/MM/DD/<its own name>; it names its own id; a missing id is detected", () => {
    expect(codexRolloutDay("rollout-2026-11-19T10-13-00-0199a.jsonl")).toBe("2026/11/19");
    expect(codexRolloutDay("odd.jsonl", Date.UTC(2026, 0, 2))).toBe("2026/01/02");
    expect(CODEX_SESSION.place({ home: "/h", cwd: "/x", id: "t1", file: "rollout-2026-11-19T10-13-00-t1.jsonl" })).toEqual({ path: "/h/.codex/sessions/2026/11/19/rollout-2026-11-19T10-13-00-t1.jsonl" });
    expect(CODEX_SESSION.firstRunArgs("t1")).toEqual([]);
    expect(CODEX_SESSION.resumeArgs("t1")).toEqual(["resume", "t1"]);
    expect(CODEX_SESSION.detectMissing("Error: thread/resume: thread/resume failed: no rollout found for thread id t1 (code -32600)")).toBe(true);
  });
});

