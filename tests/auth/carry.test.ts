// `capcomd env build --sandbox docker` moves plan logins onto the new env image (src/auth/carry.ts): only the login's
// credential files leave the old login image, they land in a container of the new env image, which is saved as the new
// login image; the env image never gets them. A login that can't be moved keeps its old image and says what to run.
// The provider here is an image store: every image is a set of files, and a container starts as a copy of its image's.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryLogin, carryLogins, loginFiles, loginsToCarry } from "../../src/auth/carry";
import { readAuthLedger, writeAuthLedger, type AuthProfile } from "../../src/auth/profiles";
import { loadAgentConfig } from "../../src/agents/config";
import { agentHome } from "../../src/agents/runner";
import { loginsOnOlderEnv } from "../../src/env/drift";
import type { SnapshotInfo } from "../../src/env/platform";

type Files = Map<string, Uint8Array>;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

/** Images and containers as file sets. exec understands the shell the carry sends: `[ -s 'f' ] && echo …` tests,
 *  mkdir/chmod (accepted), and fails on demand. */
class ImageStore {
  images = new Map<string, Files>();
  boxes = new Map<string, { image: string; files: Files }>();
  destroyed: string[] = [];
  failUpload = false;
  failSnapshot = false;
  private n = 0;
  async ensure(spec: { idemKey: string; fromSnapshot?: string }) {
    const img = this.images.get(spec.fromSnapshot ?? "");
    if (!img) throw new Error(`no image ${spec.fromSnapshot}`);
    const id = `box-${++this.n}`;
    this.boxes.set(id, { image: spec.fromSnapshot!, files: new Map(img) });
    return { id, created: true };
  }
  async waitReady() {}
  async exec(id: string, cmd: string[]) {
    const b = this.boxes.get(id)!;
    const script = cmd[2] ?? "";
    const out: string[] = [];
    for (const m of script.matchAll(/\[ -s '([^']+)' \] && echo ('([^']+)'|file)/g)) if ((b.files.get(m[1]!)?.length ?? 0) > 0) out.push(m[3] ?? "file");
    return { code: 0, stdout: out.join("\n"), stderr: "" };
  }
  async upload(id: string, path: string, data: Uint8Array) {
    if (this.failUpload) throw new Error("docker upload: connection reset");
    this.boxes.get(id)!.files.set(path, data);
  }
  async download(id: string, path: string) {
    const d = this.boxes.get(id)!.files.get(path);
    if (!d) throw new Error(`no ${path}`);
    return d;
  }
  async destroy(id: string) { this.boxes.delete(id); this.destroyed.push(id); }
  async snapshotCreate(id: string, name: string): Promise<SnapshotInfo> {
    if (this.failSnapshot) throw new Error("docker commit: no space left on device");
    this.images.set(name, new Map(this.boxes.get(id)!.files));
    return { name, status: "ready" };
  }
  async snapshotGet(name: string): Promise<SnapshotInfo | null> { return this.images.has(name) ? { name, status: "ready" } : null; }
  async snapshotList() { return [...this.images.keys()].map((name) => ({ name, status: "ready" as const })); }
  async snapshotDelete(name: string) { this.images.delete(name); }
  async setEgress() {}
  async list() { return []; }
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-carry-"));
  const ledgerPath = join(dir, "auths.json");
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: join(dir, "work") });
  const home = agentHome(cfg);
  const p = new ImageStore();
  // The old env image (CLIs, its warm template) and the new one: no login in either.
  p.images.set("capcomd-env-old", new Map([[`${home}/.gitconfig`, enc("[user]\n")], ["/var/tmp/capcomd/template/README", enc("old")]]));
  p.images.set("capcomd-env-new", new Map([[`${home}/.gitconfig`, enc("[user]\n")], ["/var/tmp/capcomd/template/README", enc("new")]]));
  // The claude login image: the old env image plus the token file (and a stray file that must not move).
  const claude = new Map(p.images.get("capcomd-env-old")!);
  claude.set(`${home}/.capcomd-auth/claude.env`, enc("export CLAUDE_CODE_OAUTH_TOKEN='scratch-not-a-token'\n"));
  claude.set(`${home}/.bash_history`, enc("history\n"));
  p.images.set("capcomd-auth-claude-old", claude);
  const codex = new Map(p.images.get("capcomd-env-old")!);
  codex.set(`${home}/.codex/auth.json`, enc('{"auth_mode":"chatgpt"}'));
  codex.set(`${home}/.codex/config.toml`, enc('cli_auth_credentials_store = "file"\n'));
  p.images.set("capcomd-auth-codex-old", codex);
  const prof = (agent: AuthProfile["agent"], snapshot: string, env: string): AuthProfile => ({ agent, snapshot, store: "snapshot", method: agent === "codex" ? "device-auth" : "setup-token", env, createdAt: "2026-11-01T00:00:00.000Z", verifiedAt: "2026-11-01T00:00:00.000Z", verified: true });
  writeAuthLedger({ "claude-code": prof("claude-code", "capcomd-auth-claude-old", "capcomd-env-old"), codex: prof("codex", "capcomd-auth-codex-old", "capcomd-env-old") }, ledgerPath);
  return { p, cfg, home, ledgerPath, opts: { envSnapshot: "capcomd-env-new", cfg, ledgerPath, sandbox: "docker", pollMs: 1 } };
}

describe("env build moves plan logins onto the new env image", () => {
  test("each login's credential files (only those) go into a new login image of the new env; the env image stays clean", async () => {
    const w = world();
    const logs: string[] = [];
    const out = await carryLogins(w.p as any, { ...w.opts, log: (l) => logs.push(l) });
    expect(out.map((r) => [r.agent, r.status, r.from, r.to])).toEqual([
      ["claude-code", "moved", "capcomd-auth-claude-old", "capcomd-auth-claude-new"],
      ["codex", "moved", "capcomd-auth-codex-old", "capcomd-auth-codex-new"],
    ]);
    const claude = w.p.images.get("capcomd-auth-claude-new")!;
    // The new env's files (its warm template), plus the login file; nothing else from the old login image.
    expect(dec(claude.get("/var/tmp/capcomd/template/README"))).toBe("new");
    expect(dec(claude.get(`${w.home}/.capcomd-auth/claude.env`))).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claude.has(`${w.home}/.bash_history`)).toBe(false);
    expect([...w.p.images.get("capcomd-auth-codex-new")!.keys()].filter((k) => k.includes(".codex")).sort()).toEqual(loginFiles("codex", w.home).sort());
    // The env image holds no login.
    for (const f of [...loginFiles("claude-code", w.home), ...loginFiles("codex", w.home)]) expect(w.p.images.get("capcomd-env-new")!.has(f)).toBe(false);
    // The ledger: the logins boot from the new images now; the old images are gone; no container left.
    const l = readAuthLedger(w.ledgerPath);
    expect(l["claude-code"]).toMatchObject({ snapshot: "capcomd-auth-claude-new", env: "capcomd-env-new", carriedFrom: "capcomd-env-old", verified: true, store: "snapshot" });
    expect(l.codex).toMatchObject({ snapshot: "capcomd-auth-codex-new", env: "capcomd-env-new", carriedFrom: "capcomd-env-old" });
    expect(w.p.images.has("capcomd-auth-claude-old")).toBe(false);
    expect(w.p.boxes.size).toBe(0);
    // So env status / doctor have nothing to warn about, and a second build has nothing to move.
    expect(loginsOnOlderEnv("capcomd-env-new", Object.values(l))).toEqual([]);
    expect(await carryLogins(w.p as any, w.opts)).toEqual([]);
    expect(logs.join("\n")).not.toContain("scratch-not-a-token");
  });

  test("a login that can't be moved keeps working from its old image, says what to run, and leaves nothing half-made", async () => {
    const w = world();
    w.p.failSnapshot = true;
    const r = await carryLogin(w.p as any, "claude-code", w.opts);
    expect(r).toMatchObject({ status: "failed", from: "capcomd-auth-claude-old", to: null });
    expect(r.message).toContain("couldn't be moved to capcomd-env-new (docker commit: no space left on device)");
    expect(r.message).toContain("its agents still boot from capcomd-auth-claude-old");
    expect(r.message).toContain("`capcomd auth login claude --sandbox docker`");
    expect(readAuthLedger(w.ledgerPath)["claude-code"]).toMatchObject({ snapshot: "capcomd-auth-claude-old", env: "capcomd-env-old" });
    expect(w.p.images.has("capcomd-auth-claude-old")).toBe(true);
    expect(w.p.images.has("capcomd-auth-claude-new")).toBe(false);
    expect(w.p.boxes.size).toBe(0);
    // The note env status shows still names it, with the commands.
    const notes = loginsOnOlderEnv("capcomd-env-new", Object.values(readAuthLedger(w.ledgerPath)));
    expect(notes[0]).toContain("capcomd env build --sandbox docker");
    expect(notes[0]).toContain("capcomd auth login claude --sandbox docker");
    // A failed copy, an old image that's gone, an image with no login in it: the same, never a throw.
    w.p.failSnapshot = false; w.p.failUpload = true;
    expect((await carryLogin(w.p as any, "codex", w.opts)).status).toBe("failed");
    w.p.failUpload = false;
    w.p.images.delete("capcomd-auth-codex-old");
    expect((await carryLogin(w.p as any, "codex", w.opts)).message).toContain("its image capcomd-auth-codex-old is gone");
    w.p.images.set("capcomd-auth-codex-old", new Map(w.p.images.get("capcomd-env-old")!));
    expect((await carryLogin(w.p as any, "codex", w.opts)).message).toContain("no login files in capcomd-auth-codex-old");
    // Fixed: the next build moves it.
    expect((await carryLogin(w.p as any, "claude-code", w.opts)).status).toBe("moved");
  });

  test("which logins move: image logins on another env only (a boxd secret, or one already on it, doesn't)", () => {
    const base = { method: "setup-token" as const, createdAt: "x" };
    expect(loginsToCarry("e2", [
      { ...base, agent: "claude-code", store: "secret", env: "e1" },
      { ...base, agent: "codex", store: "snapshot", snapshot: "a2", env: "e2" },
      { ...base, agent: "codex", store: "snapshot", snapshot: "a1", env: "e1" },
    ]).map((p) => p.snapshot)).toEqual(["a1"]);
  });

  test("an fx login moves as its session file; one that can't names its own login in what to run", async () => {
    const w = world();
    expect(loginFiles("fx", w.home)).toEqual([`${w.home}/.fx/auth.json`, `${w.home}/.fx/grok-auth.json`]);
    const fx = new Map(w.p.images.get("capcomd-env-old")!);
    fx.set(`${w.home}/.fx/grok-auth.json`, enc('{"refresh_token":"scratch-not-a-token"}'));
    fx.set(`${w.home}/.fx/sessions/s1.json`, enc("{}"));
    w.p.images.set("capcomd-auth-fx-old", fx);
    const l = readAuthLedger(w.ledgerPath);
    writeAuthLedger({ ...l, fx: { agent: "fx", snapshot: "capcomd-auth-fx-old", store: "snapshot", method: "browser-code", login: "grok", env: "capcomd-env-old", createdAt: "x" } }, w.ledgerPath);
    expect(loginsOnOlderEnv("capcomd-env-new", [readAuthLedger(w.ledgerPath).fx!])[0]).toContain("`capcomd auth login fx grok --sandbox docker`");
    w.p.failSnapshot = true;
    const failed = await carryLogin(w.p as any, "fx", w.opts);
    expect(failed.message).toContain("`capcomd auth login fx grok --sandbox docker`");
    w.p.failSnapshot = false;
    expect(await carryLogin(w.p as any, "fx", w.opts)).toMatchObject({ status: "moved", to: "capcomd-auth-fx-new" });
    const moved = w.p.images.get("capcomd-auth-fx-new")!;
    expect(moved.has(`${w.home}/.fx/grok-auth.json`)).toBe(true);
    expect(moved.has(`${w.home}/.fx/sessions/s1.json`)).toBe(false);
    expect(readAuthLedger(w.ledgerPath).fx).toMatchObject({ snapshot: "capcomd-auth-fx-new", login: "grok", carriedFrom: "capcomd-env-old" });
  });
});
