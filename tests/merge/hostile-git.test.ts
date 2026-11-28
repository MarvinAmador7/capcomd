// A sandbox's commits are hostile data (docs/spec/plugin-api.md §11.7 item 5): an agent, or code in its VM, can plant
// anything in its checkout (its .git/config, hooks, a `git` on its PATH) and make the bundle it hands the host say
// anything. The host takes its work only as a bundle it checks (src/merge/host-git.ts receiveBundle) and runs every git
// command on it under HOST_POLICY. Each test plants a vector whose command, if it ever ran on the host, leaves a marker:
// the sandbox side runs with CAPCOMD_SANDBOX_SIDE=1 (its own hooks and fsmonitor may run there, and record nothing),
// so a marker is a command the host ran. Hostile work is refused with its reason, and never reaches the mirror or the
// remote; normal work (a symlink, a .gitattributes, a 3-way merge) lands as before.
// The sandbox is FakeProvider's host mode: its commands run on this machine with only the env they are given.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo, withoutEngine } from "./gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { AGENT_EGRESS } from "../../src/agents/config";
import { Git } from "../../src/merge/git";
import { BundleRefused, HOST_POLICY, hostGit, initHostRepo, isSafeRefName, receiveBundle, remoteGit } from "../../src/merge/host-git";
import { pushFromSandbox, sendToSandbox, TransferError, type SandboxGit } from "../../src/merge/transfer";
import { mergeTask } from "../../src/merge/service";
import { taskBranch } from "../../src/merge/config";
import { plant } from "../helpers/plant-git-vectors";

withoutEngine();

const ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
let saved: Record<string, string | undefined> = {};
const roots: string[] = [];
beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
const REAL_GIT = Bun.which("git")!;

/** A command that leaves `<leak>/<name>` when it runs outside the sandbox (and reads its stdin, for a filter). */
function spy(leak: string, name: string, body = "cat >/dev/null 2>&1; exit 0"): string {
  const p = join(leak, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\n[ -n "$CAPCOMD_SANDBOX_SIDE" ] || { mkdir -p '${leak}/ran' && touch '${leak}/ran/${name}'; }\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const ran = (leak: string) => existsSync(join(leak, "ran")) ? readdirSync(join(leak, "ran")).sort() : [];

/** The operator's own git settings (as a global config would set them): a hook for every event, an fsmonitor, ssh, and
 *  filter, diff and merge drivers (LFS's too) that a sandbox's .gitattributes could select. */
function operatorConfig(leak: string): string {
  const hooks = join(leak, "operator-hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit", "post-checkout", "post-merge", "post-rewrite", "pre-rebase", "pre-push", "reference-transaction", "pre-auto-gc"]) {
    writeFileSync(join(hooks, h), `#!/bin/sh\nmkdir -p '${leak}/ran' && touch '${leak}/ran/operator-hook-${h}'\nexit 1\n`);
    chmodSync(join(hooks, h), 0o755);
  }
  const attrs = join(leak, "operator-attributes");
  writeFileSync(attrs, "* filter=evil diff=evil merge=evil\n");
  const file = join(leak, "operator.gitconfig");
  writeFileSync(file, `[core]
\thooksPath = ${hooks}
\tfsmonitor = ${spy(leak, "operator-fsmonitor")}
\tsshCommand = ${spy(leak, "operator-ssh", "exit 1")}
\tattributesFile = ${attrs}
[filter "evil"]
\tsmudge = ${spy(leak, "operator-smudge", "cat")}
\tclean = ${spy(leak, "operator-clean", "cat")}
[filter "lfs"]
\tsmudge = ${spy(leak, "operator-lfs-smudge", "cat")}
\tprocess = ${spy(leak, "operator-lfs-process", "exit 1")}
\trequired = true
[diff "evil"]
\ttextconv = ${spy(leak, "operator-textconv", "cat \"$1\"")}
\tcommand = ${spy(leak, "operator-diff")}
[merge "evil"]
\tdriver = ${spy(leak, "operator-merge-driver", "exit 0")} %O %A %B
`);
  return file;
}

/** A repository on a local bare "remote", a sandbox (host mode) holding its clone, and the host's side of it. */
async function world(o: { strategy?: "squash" | "rebase" | "merge"; path?: string } = {}) {
  const r = await bareRepo({ strategy: o.strategy ?? "squash" });
  roots.push(r.root);
  const root = temp("capcomd-hostile-");
  const leak = join(root, "leak");
  const home = join(root, "box-home");
  const bin = join(root, "box-bin");
  mkdirSync(leak, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
  const p = new FakeProvider({ hostExec: true });
  const { id } = await p.ensure({ idemKey: `hostile-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await p.waitReady(id, 1000);
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, CAPCOMD_SANDBOX_SIDE: "1",
    GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@box", GIT_COMMITTER_NAME: "agent", GIT_COMMITTER_EMAIL: "agent@box",
  };
  const box: SandboxGit = { exec: (cmd, x) => p.exec(id, cmd, { env, ...x }), upload: (a, d) => p.upload(id, a, d), download: (a) => p.download(id, a) };
  const h = { remote: r.bare, workdir: r.cfg.workdir };
  // The bare "remote" stands for a server: its own settings, not the operator's (a push to a path runs its
  // receive-pack here, with this process's global config).
  await new Git(r.bare).ok(["config", "core.hooksPath", join(r.root, "no-hooks")]);
  const dir = join(root, "box", "repo");
  await sendToSandbox(h, box, dir, { branches: "all", checkout: "main" }, { fresh: true });
  const sh = async (script: string) => {
    const x = await box.exec(["sh", "-c", `cd '${dir}' && ${script}`]);
    if (x.code !== 0) throw new Error(`sandbox: ${script}: ${x.stderr}`);
    return x.stdout.trim();
  };
  const branch = taskBranch("run9", "t1");
  return {
    r, h, box, dir, leak, home, bin, sh, branch,
    /** The agent's commit of what's in its checkout now. */
    commit: async (msg = "agent work") => (await sh(`git add -A && git commit -qm '${msg}' && git rev-parse HEAD`)).split("\n").pop()!,
    /** The agent's branch pushed through the host, as the runner pushes it. */
    push: (sha: string) => pushFromSandbox(h, box, dir, { sha, ref: `refs/heads/${branch}`, expect: null, near: ["main"] }),
    /** Verify, then merge, as the run's merge does. */
    land: async () => {
      const v = await mergeTask({ runId: "run9", taskId: "t1", branch, target: "main", testOnly: true }, r.cfg);
      const m = await mergeTask({ runId: "run9", taskId: "t1", branch, target: "main" }, r.cfg);
      return { v, m };
    },
  };
}

/** The refused push's error: a TransferError of kind "refused", and the branch never reached the remote. */
async function refused(w: Awaited<ReturnType<typeof world>>, sha: string): Promise<string> {
  const err = await w.push(sha).then(() => null, (e) => e);
  expect(err).toBeInstanceOf(TransferError);
  expect(err.kind).toBe("refused");
  expect(await w.r.sha(`refs/heads/${w.branch}`)).toBeNull();
  // Nothing of it in the host's mirror either: the objects stayed in the quarantine.
  const mirrors = readdirSync(w.h.workdir).map((d) => join(w.h.workdir, d, "_mirror")).filter((d) => existsSync(d));
  for (const m of mirrors) expect((await new Git(m).run(["cat-file", "-e", `${sha}^{commit}`])).code).not.toBe(0);
  return String(err.message);
}

describe("work that comes back from a sandbox", () => {
  test("a planted checkout and the operator's own git settings run nothing on the host; normal work lands as before", async () => {
    const w = await world();
    // The agent's checkout and HOME: every vector (core.fsmonitor, core.sshCommand, core.hooksPath, hooks, filters,
    // credential helpers, include.path, …), its commands marked as the sandbox's.
    const evil = (await bareRepo()).bare;
    const vectors = join(w.leak, "vectors");
    mkdirSync(vectors);
    await plant(w.dir, w.home, vectors, evil, w.r.bare);
    for (const h of ["post-checkout", "post-merge", "pre-commit", "post-commit", "reference-transaction", "pre-push"]) {
      writeFileSync(join(w.dir, ".git", "hooks", h), `#!/bin/sh\n[ -n "$CAPCOMD_SANDBOX_SIDE" ] || { mkdir -p '${w.leak}/ran' && touch '${w.leak}/ran/sandbox-hook-${h}'; }\nexit 0\n`);
      chmodSync(join(w.dir, ".git", "hooks", h), 0o755);
    }
    await w.sh(`git config core.fsmonitor '${spy(w.leak, "sandbox-fsmonitor")}' && git config core.sshCommand '${spy(w.leak, "sandbox-ssh", "exit 1")}' && git config core.hooksPath .git/hooks`);
    // Its work: a file, a symlink, attributes selecting the operator's drivers and LFS, and a change to a line of
    // shared.txt that main also changes elsewhere (a real 3-way merge, where a merge driver would run).
    writeFileSync(join(w.dir, "feature.txt"), "agent work\n");
    writeFileSync(join(w.dir, "asset.bin"), "binary-ish\n");
    writeFileSync(join(w.dir, ".gitattributes"), "* filter=evil diff=evil merge=evil\n*.bin filter=lfs diff=lfs merge=lfs\n");
    writeFileSync(join(w.dir, "shared.txt"), "line 1 by the agent\nline 2\nline 3\n");
    await w.sh("ln -s README.md readme-link");
    const sha = await w.commit();
    await w.r.pushToMain("shared.txt", "line 1\nline 2\nline 3 on main\n");

    process.env.GIT_CONFIG_GLOBAL = operatorConfig(w.leak);
    await w.push(sha);
    const { v, m } = await w.land();
    delete process.env.GIT_CONFIG_GLOBAL;

    expect(v.status).toBe("verified");
    expect(m.status).toBe("merged");
    // Landed as git stores it: the 3-way merge by git's own rules, the symlink still a symlink, no filter applied.
    expect(await w.r.show("main", "shared.txt")).toBe("line 1 by the agent\nline 2\nline 3 on main");
    expect(await w.r.show("main", "feature.txt")).toBe("agent work");
    expect((await new Git(w.r.bare).ok(["ls-tree", "main", "readme-link"])).split(/\s/)[0]).toBe("120000");
    // Nothing ran on the host: not the agent's settings or hooks, not the operator's hooks, fsmonitor, filters or drivers.
    expect(ran(w.leak)).toEqual([]);
    const envs = readdirSync(vectors).filter((f) => f.endsWith(".env"));
    expect(envs.filter((f) => !readFileSync(join(vectors, f), "utf8").includes("CAPCOMD_SANDBOX_SIDE=1"))).toEqual([]);
  }, 90_000);

  for (const strategy of ["rebase", "merge"] as const) {
    test(`${strategy}: a normal commit with a symlink lands as before, nothing runs on the host`, async () => {
      const w = await world({ strategy });
      writeFileSync(join(w.dir, "feature.txt"), "agent work\n");
      await w.sh("ln -s feature.txt feature-link");
      const sha = await w.commit();
      await w.r.pushToMain("other.txt", "moved\n");
      process.env.GIT_CONFIG_GLOBAL = operatorConfig(w.leak);
      await w.push(sha);
      const { m } = await w.land();
      delete process.env.GIT_CONFIG_GLOBAL;
      expect(m.status).toBe("merged");
      expect((await new Git(w.r.bare).ok(["ls-tree", "main", "feature-link"])).split(/\s/)[0]).toBe("120000");
      expect(ran(w.leak)).toEqual([]);
    }, 60_000);
  }

  test("a bundle whose ref is named like ../../x (a planted `git` rewrote it) is refused", async () => {
    const w = await world();
    // The agent's `git`, first on its PATH: the bundle it makes names another ref.
    writeFileSync(join(w.bin, "git"), `#!/bin/sh
if [ "$1" = bundle ] && [ "$2" = create ]; then
  '${REAL_GIT}' "$@" || exit $?
  perl -0777 -i -pe 's{^([0-9a-f]{40}) refs/capcomd/out/[^\\n]+$}{$1 refs/capcomd/out/../../x}m' "$4"
  exit 0
fi
exec '${REAL_GIT}' "$@"
`);
    chmodSync(join(w.bin, "git"), 0o755);
    writeFileSync(join(w.dir, "feature.txt"), "agent work\n");
    const sha = await w.commit();
    const msg = await refused(w, sha);
    expect(msg).toContain("the host refused the sandbox's bundle");
    expect(msg).toContain('a ref named "refs/capcomd/out/../../x"');
    expect(ran(w.leak)).toEqual([]);
  }, 60_000);

  test("a .gitmodules with a carriage return in a submodule path (CVE-2025-48384) is refused", async () => {
    const w = await world();
    // The submodule's checkout would be written to "sub\r" and its config read back as "sub": a hook planted through it.
    writeFileSync(join(w.dir, ".gitmodules"), `[submodule "sub"]\n\tpath = "sub\r"\n\turl = ${w.r.bare}\n`);
    const base = (await w.sh("git rev-parse HEAD")).trim();
    await w.sh(`git update-index --add --cacheinfo 160000,${base},sub && git add .gitmodules`);
    const sha = await w.commit("submodule");
    const msg = await refused(w, sha);
    expect(msg).toContain(".gitmodules");
    expect(msg).toContain("CVE-2025-48384");
    expect(ran(w.leak)).toEqual([]);
  }, 60_000);

  test("a symlink into .git/hooks is refused", async () => {
    const w = await world();
    await w.sh("ln -s .git/hooks hooks");
    const sha = await w.commit("link");
    const msg = await refused(w, sha);
    expect(msg).toContain('symlink "hooks" points into .git');
    expect(ran(w.leak)).toEqual([]);
  }, 60_000);
});

describe("receiveBundle: what a bundle may hold", () => {
  /** A host repo with main's first commit, and a fixture repository to make bundles from. */
  async function stage() {
    const root = temp("capcomd-bundles-");
    const src = join(root, "src");
    mkdirSync(src);
    const g = new Git(src);
    await g.ok(["init", "-q", "-b", "main"]);
    writeFileSync(join(src, "a.txt"), "a\n");
    await g.ok(["add", "a.txt"]);
    await g.ok(["commit", "-q", "-m", "base"]);
    const base = await g.ok(["rev-parse", "HEAD"]);
    const host = await initHostRepo(join(root, "host.git"), { bare: true });
    const f = await remoteGit(host, ["fetch", "-q", src, "+refs/heads/main:refs/remotes/origin/main"], src);
    expect(f.code).toBe(0);
    /** A commit on main whose root tree has `entries` (one level: `dir/name` makes a subtree), bundled as `ref`. */
    const bundle = async (entries: Array<{ path: string; mode?: string; content: string }>, ref = "refs/capcomd/out/x") => {
      const blob = async (s: string) => (await g.ok(["hash-object", "-w", "--stdin"], { input: s })).trim();
      const top: string[] = [];
      const dirs = new Map<string, string[]>();
      for (const e of entries) {
        const line = async (name: string) => `${e.mode ?? "100644"} blob ${await blob(e.content)}\t${name}`;
        const [d, ...rest] = e.path.split("/");
        if (rest.length) dirs.set(d!, [...(dirs.get(d!) ?? []), await line(rest.join("/"))]);
        else top.push(await line(d!));
      }
      for (const [d, lines] of dirs) top.push(`040000 tree ${(await g.ok(["mktree"], { input: lines.join("\n") + "\n" })).trim()}\t${d}`);
      const tree = (await g.ok(["mktree"], { input: top.join("\n") + "\n" })).trim();
      const sha = (await g.ok(["commit-tree", tree, "-p", base, "-m", "work"])).trim();
      await g.ok(["update-ref", ref, sha]);
      const file = join(root, `b-${Math.random().toString(36).slice(2)}.bundle`);
      await g.ok(["bundle", "create", "-q", file, ref, `^${base}`]);
      return { file, sha };
    };
    /** `file` with its header's lines passed through `edit`. */
    const rewrite = (file: string, edit: (lines: string[]) => string[]) => {
      const buf = readFileSync(file);
      const end = buf.indexOf("\n\n");
      const lines = edit(buf.subarray(0, end).toString("latin1").split("\n"));
      writeFileSync(file, Buffer.concat([Buffer.from(lines.join("\n"), "latin1"), buf.subarray(end)]));
      return file;
    };
    const receive = (file: string, ref = "refs/capcomd/out/x") => receiveBundle(host, file, { ref, into: "refs/capcomd/xfer/t/in" });
    const has = async (sha: string) => (await host.run(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
    return { host, bundle, rewrite, receive, has, base };
  }

  const why = async (p: Promise<unknown>) => { const e = await p.then(() => null, (x) => x); expect(e).toBeInstanceOf(BundleRefused); return String(e.message); };

  test("a plain bundle comes in at the ref asked for", async () => {
    const s = await stage();
    const { file, sha } = await s.bundle([{ path: "a.txt", content: "a\n" }, { path: "b.txt", content: "b\n" }, { path: "link", mode: "120000", content: "b.txt" }]);
    expect(await s.receive(file)).toEqual({ ok: true, sha });
    expect((await s.host.ok(["rev-parse", "refs/capcomd/xfer/t/in"])).trim()).toBe(sha);
    expect(readdirSync(join(s.host.cwd, "xfer")).filter((f) => f.startsWith("quarantine-"))).toEqual([]);
  });

  test("refs: traversal, control characters, another ref, a second ref, a filter, not a bundle", async () => {
    const s = await stage();
    const cases: Array<[string, (l: string[]) => string[], RegExp]> = [
      ["traversal", (l) => l.map((x) => x.replace("refs/capcomd/out/x", "refs/capcomd/out/../../x")), /a ref named "refs\/capcomd\/out\/..\/..\/x"/],
      ["escape", (l) => l.map((x) => x.replace("refs/capcomd/out/x", "refs/capcomd/out/x\x1b[2J")), /a ref named "refs\/capcomd\/out\/x\\u001b\[2J"/],
      ["carriage return", (l) => l.map((x) => x.replace("refs/capcomd/out/x", "refs/capcomd/out/x\rrefs/heads/main")), /a ref named/],
      ["space", (l) => l.map((x) => x.replace("refs/capcomd/out/x", "refs/capcomd/out/x y")), /a ref named/],
      ["another ref", (l) => l.map((x) => x.replace("refs/capcomd/out/x", "refs/heads/main")), /should hold refs\/capcomd\/out\/x alone, and it holds "refs\/heads\/main"/],
      ["a second ref", (l) => [...l, l.at(-1)!.replace("refs/capcomd/out/x", "refs/heads/main")], /and it holds "refs\/capcomd\/out\/x", "refs\/heads\/main"/],
      ["a filter", (l) => ["# v3 git bundle", "@object-format=sha1", "@filter=blob:none", ...l.slice(1)], /"@filter=blob:none", which capcomd doesn't take/],
      ["not a bundle", () => ["#!/bin/sh", "touch /tmp/x"], /isn't a git bundle v2 or v3/],
    ];
    for (const [name, edit, expected] of cases) {
      const { file, sha } = await s.bundle([{ path: "b.txt", content: `${name}\n` }]);
      expect(await why(s.receive(s.rewrite(file, edit)))).toMatch(expected);
      expect(await s.has(sha)).toBe(false);
    }
    expect((await s.host.run(["rev-parse", "-q", "--verify", "refs/capcomd/xfer/t/in"])).code).not.toBe(0);
  });

  test("trees: .git in any spelling, symlinks into .git, .gitmodules tricks", async () => {
    const s = await stage();
    const hook = "#!/bin/sh\ntouch /tmp/pwned\n";
    const cases: Array<[Array<{ path: string; mode?: string; content: string }>, RegExp]> = [
      [[{ path: ".GIT/hooks", content: hook }], /object checks failed: .*hasDotgit/s],
      [[{ path: ".git/config", content: "[core]\n\tfsmonitor = touch /tmp/pwned\n" }], /object checks failed/],
      [[{ path: "x/.Git", content: hook }], /object checks failed: .*hasDotgit/s],
      [[{ path: "hooks", mode: "120000", content: ".git/hooks" }], /symlink "hooks" points into .git/],
      [[{ path: "a", mode: "120000", content: "./sub/../.GIT/" }], /symlink "a" points into .git/],
      [[{ path: "b", mode: "120000", content: "x/.git‌/hooks" }], /symlink "b" points into .git/],
      [[{ path: "c", mode: "120000", content: "GIT~1/hooks" }], /symlink "c" points into .git/],
      [[{ path: ".gitmodules", content: '[submodule "s"]\n\tpath = "s\r"\n\turl = https://example.com/s\n' }], /control character .*CVE-2025-48384/],
      [[{ path: ".gitmodules", content: '[submodule "s"]\n\tpath = s\n\turl = --upload-pack=touch /tmp/pwned\n' }], /object checks failed|read as an option/],
      [[{ path: ".gitmodules", content: '[submodule "s"]\n\tpath = ../../outside\n\turl = https://example.com/s\n' }], /out of the tree or into .git/],
      [[{ path: ".gitmodules", content: '[submodule "s"]\n\tpath = s\n\turl = https://example.com/s\n\tupdate = !touch /tmp/pwned\n' }], /object checks failed|a command/],
      [[{ path: ".gitmodules", mode: "120000", content: "/etc/passwd" }], /object checks failed/],
    ];
    for (const [entries, expected] of cases) {
      const { file, sha } = await s.bundle(entries);
      expect(await why(s.receive(file))).toMatch(expected);
      expect(await s.has(sha)).toBe(false);
    }
    // A CRLF .gitmodules (an editor's line endings, no trick) and ordinary symlinks are fine.
    const ok = await s.bundle([{ path: ".gitmodules", content: '[submodule "s"]\r\n\tpath = s\r\n\turl = https://example.com/s\r\n' }, { path: "l1", mode: "120000", content: "../shared/.github/x" }, { path: "l2", mode: "120000", content: "a.txt" }]);
    expect(await s.receive(ok.file)).toEqual({ ok: true, sha: ok.sha });
  });

  test("a bundle that builds on a commit the repository hasn't got is `missing`, not refused", async () => {
    const s = await stage();
    const { file } = await s.bundle([{ path: "b.txt", content: "b\n" }]);
    const bare = await initHostRepo(join(s.host.cwd, "..", "empty.git"), { bare: true });
    const r = await receiveBundle(bare, file, { ref: "refs/capcomd/out/x", into: "refs/capcomd/xfer/t/in" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.missing).toBe(true);
  });
});

describe("the host repo policy", () => {
  test("no hooks, fsmonitor, submodules, symlinks or transport; the user's settings only for network commands", async () => {
    const root = temp("capcomd-policy-");
    const leak = join(root, "leak");
    mkdirSync(leak);
    process.env.GIT_CONFIG_GLOBAL = operatorConfig(leak);
    const g = hostGit(join(root, "repo"));
    mkdirSync(g.cwd);
    await g.ok(["init", "-q"]);
    const get = async (k: string, network = false) => (await g.run(["config", "--get", k], { network })).stdout.trim();
    expect(await get("core.hooksPath")).toBe("/dev/null");
    expect(await get("core.fsmonitor")).toBe("false");
    expect(await get("core.symlinks")).toBe("false");
    expect(await get("submodule.recurse")).toBe("false");
    expect(await get("protocol.allow")).toBe("never");
    // Local work: none of the user's drivers; network work keeps their settings (ssh), still without hooks.
    expect(await get("filter.evil.smudge")).toBe("");
    expect(await get("core.sshCommand")).toBe("");
    expect(await get("core.sshCommand", true)).toContain("operator-ssh");
    expect(await get("core.hooksPath", true)).toBe("/dev/null");
    expect(g.policy).toBe(HOST_POLICY);
    expect(ran(leak)).toEqual([]);
  });

  test("ref names", () => {
    for (const ok of ["refs/heads/main", "refs/capcomd/out/1-a.b_c", "refs/heads/capcomd/run/t"]) expect(isSafeRefName(ok)).toBe(true);
    for (const bad of ["refs/capcomd/out/../../x", "refs/x/.hidden", "refs/x/y.lock", "refs/x//y", "refs/x/y/", "refs/x\ty", "refs/x\x1by", "refs/x@{1}", "heads/main", "refs/x y", `refs/${"a".repeat(260)}`]) expect(isSafeRefName(bad)).toBe(false);
  });
});
