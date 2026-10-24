// capcomd setup's boxd key: kept when valid, else made with the logged-in boxd CLI (a key just for capcomd, never
// shown), else a clear next step. A fake `boxd` binary stands in for the CLI; the keychain and boxd's API are stubs.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { boxdKeyName, boxdKeyStep, type KeyDeps } from "../../src/cli/commands/setup";
import { prompter } from "../../src/cli/prompt";

const dir = mkdtempSync(join(tmpdir(), "capcomd-boxdkey-"));
const calls = join(dir, "calls.log");
const fake = join(dir, "boxd");
// FAKE_BOXD: in (one active org) | multi (two orgs, none active) | out (logged out). Logs every call.
writeFileSync(fake, `#!/bin/sh
echo "$@" >> ${JSON.stringify(calls)}
if [ "$1 $2" = "auth --json" ]; then
  echo "  A new version of boxd is available (v9.9.9)." >&2
  case "$FAKE_BOXD" in
    out) echo "error: not logged in; run boxd auth login" >&2; exit 1 ;;
    multi) echo '{"active_org":null,"display_name":"Dev","orgs":[{"active":false,"id":"org-a","name":"Alpha"},{"active":false,"id":"org-b","name":"Beta"}],"user_id":"usr_1"}' ;;
    *) echo '{"active_org":null,"display_name":"Dev","orgs":[{"active":true,"id":"org-a","name":"Alpha"}],"user_id":"usr_1"}' ;;
  esac
  exit 0
fi
if [ "$1 $2 $3" = "auth keys create" ]; then
  org=active; [ "$5" = "--org" ] && org=$6
  echo "{\\"id\\":\\"key_1\\",\\"api_key\\":\\"bxd_made_$org\\",\\"expires_at\\":0}"; exit 0
fi
exit 2
`);
chmodSync(fake, 0o755);

const saved = { ...process.env };
let kc: { value: string | null; kind: string | null };
const valid = new Set<string>();
const deps = (): KeyDeps => ({ validate: async (k) => valid.has(k) || k.startsWith("bxd_made_"), kcGet: () => kc.value, kcSet: (k) => { kc.value = k; }, kcKind: () => kc.kind });
const yes = prompter({ yes: true });
const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");

beforeEach(() => {
  kc = { value: null, kind: "macos" };
  valid.clear();
  writeFileSync(calls, "");
  delete process.env.BOXD_API_KEY;
  process.env.CAPCOMD_HOME = mkdtempSync(join(tmpdir(), "capcomd-boxdkey-home-"));
  process.env.CAPCOMD_BOXD_CLI = fake;
  process.env.FAKE_BOXD = "in";
});
afterAll(() => {
  for (const k of ["BOXD_API_KEY", "CAPCOMD_HOME", "CAPCOMD_BOXD_CLI", "FAKE_BOXD"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test("logged-in CLI: creates a named key in the active org, keeps it in the keychain, never shows it", async () => {
  const s = await boxdKeyStep(yes, {}, deps());
  expect(s.ok).toBe(true);
  // the active org: no --org (the boxd CLI rejects it there)
  expect(log()).toContain(`auth keys create ${boxdKeyName()} --json`);
  expect(kc.value).toBe("bxd_made_active");
  expect(s.detail).toContain(`revoke with \`boxd auth keys rm ${boxdKeyName()}\``);
  expect(s.detail).not.toContain("bxd_made");
  expect(JSON.parse(readFileSync(join(process.env.CAPCOMD_HOME!, "config.json"), "utf8"))).toMatchObject({ env: { CAPCOMD_SANDBOX: "boxd" }, boxdKey: "keychain" });
});

test("a valid key in the environment or keychain is kept; nothing is created", async () => {
  valid.add("bxd_env");
  process.env.BOXD_API_KEY = "bxd_env";
  expect((await boxdKeyStep(yes, {}, deps())).ok).toBe(true);
  delete process.env.BOXD_API_KEY;
  valid.add("bxd_kc"); kc.value = "bxd_kc";
  const s = await boxdKeyStep(yes, {}, deps());
  expect(s.detail).toContain("valid (keychain)");
  expect(log()).not.toContain("keys create");
});

test("a stale keychain key is replaced by a new one", async () => {
  kc.value = "bxd_revoked";
  const s = await boxdKeyStep(yes, {}, deps());
  expect(s.ok).toBe(true);
  expect(kc.value).toBe("bxd_made_active");
});

test("a rejected BOXD_API_KEY is reported, not silently replaced", async () => {
  process.env.BOXD_API_KEY = "bxd_bad";
  const s = await boxdKeyStep(yes, {}, deps());
  expect(s.ok).toBe(false);
  expect(s.hint).toContain("unset it");
});

test("several orgs and none active: asks for --org; --org picks one by name", async () => {
  process.env.FAKE_BOXD = "multi";
  const s = await boxdKeyStep(yes, {}, deps());
  expect(s.ok).toBe(false);
  expect(s.hint).toContain("--org");
  expect(s.hint).toContain("Alpha, Beta");
  expect((await boxdKeyStep(yes, { org: "Beta" }, deps())).ok).toBe(true);
  expect(kc.value).toBe("bxd_made_org-b");
  delete process.env.BOXD_API_KEY; kc.value = null; // the step exports the key it made
  expect((await boxdKeyStep(yes, { org: "Gamma" }, deps())).hint).toContain("Your orgs: Alpha, Beta");
});

test("logged out or not installed: says exactly what to run", async () => {
  process.env.FAKE_BOXD = "out";
  const out = await boxdKeyStep(yes, {}, deps());
  expect(out).toMatchObject({ ok: false, detail: "no boxd key, and the boxd CLI isn't logged in" });
  expect(out.hint).toContain("boxd auth login");
  process.env.CAPCOMD_BOXD_CLI = join(dir, "no-such-boxd");
  const none = await boxdKeyStep(yes, {}, deps());
  expect(none.detail).toContain("isn't installed");
  expect(none.hint).toContain("https://boxd.sh/downloads/install.sh");
});

test("no OS keychain: a key setup created goes to the 0600 credentials file, not lost", async () => {
  kc.kind = null;
  const s = await boxdKeyStep(yes, {}, deps());
  expect(s.detail).toContain("kept in the file");
  const f = join(process.env.CAPCOMD_HOME!, "credentials");
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ BOXD_API_KEY: "bxd_made_active" });
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("inside a boxd machine with credentials of its own (an agent on boxd): no key is created or stored", async () => {
  const s = await boxdKeyStep(yes, {}, { ...deps(), machine: async () => ({ inside: true, credentials: true, detail: "inside boxd machine hermes: using its credentials" }) });
  expect(s).toMatchObject({ ok: true, detail: "none needed: inside boxd machine hermes: using its credentials" });
  expect(log()).not.toContain("auth keys create");
  expect(kc.value).toBeNull();
  expect(JSON.parse(readFileSync(join(process.env.CAPCOMD_HOME!, "config.json"), "utf8"))).toEqual({ env: { CAPCOMD_SANDBOX: "boxd" } });
  // an isolated machine (no credentials) still goes the key way
  const iso = await boxdKeyStep(yes, {}, { ...deps(), machine: async () => ({ inside: true, credentials: false, detail: "403: VM is isolated" }) });
  expect(log()).toContain("auth keys create");
  expect(iso.ok).toBe(true);
});
