// Plugin API §11.7: host git never runs with credentials in an agent-editable checkout. An agent can write anything in
// its sandbox: its checkout's .git/config, hooks and remotes, its HOME's .gitconfig, a `git` earlier on its PATH. Each
// vector below tries to get a (fake) git token or to run a command where the token is, during a push, a checkpoint
// push, a clone, a `capcomd fetch` and a merge, and the host refuses or neutralises it:
//  - no git command in the sandbox carries a credential, even on a provider that would hand one to a sandbox's
//    network git (as the boxd and Docker providers did): the sandbox runs no network git at all;
//  - the push and fetch go to the run's repository by its URL from the host's mirror, so a planted insteadOf, pushurl
//    or remote URL in the checkout changes nothing;
//  - a host repo (a clone, the mirror) whose settings or hooks changed since capcomd made it is refused.
// The sandbox is FakeProvider's host mode: its commands run on this machine, with only the env the caller gives (as a
// VM's do), so a planted command that ever saw the token ran in a process that held it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import type { ExecResult, VmId } from "../../src/providers/sandbox";
import { Git } from "../../src/merge/git";
import { HostRepoRefused, hostCredentialEnv, hostRepoProblems, initHostRepo, lsRemote, remoteGit } from "../../src/merge/host-git";
import { pushFromSandbox, sendToSandbox, type SandboxGit } from "../../src/merge/transfer";
import { directMerge } from "../../src/merge/direct";
import { produceFakeWork } from "../../src/merge/fakework";
import { taskBranch } from "../../src/merge/config";
import { GitForge } from "../../src/plugins/forges/git";
import { runClaudeCode } from "../../src/agents/claude-code";
import { loadAgentConfig, AGENT_EGRESS } from "../../src/agents/config";
import { agentHome } from "../../src/agents/runner";
import { plant, spy } from "../helpers/plant-git-vectors";
import { getFinishedSpans } from "../../src/utils/tracing-simple";

const TOKEN = "ghp_capcomdFAKEtoken0123456789abcdefABCD";
const NET = /^(fetch|push|ls-remote|clone|pull)$/;
const FAKE_CLAUDE = join(import.meta.dir, "..", "agents", "fake-claude.sh");

let saved: string | undefined;
beforeAll(() => { saved = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = TOKEN; });
afterAll(() => { if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved; });

/**
 * A provider that hands the token to every network git command run in its sandbox, as the boxd and Docker providers
 * did before (their per-exec credential hook): the token reaches the sandbox only if capcomd runs network git there.
 */
class CredentialedSandbox extends FakeProvider {
  credentialed = 0;
  override async exec(id: VmId, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string }): Promise<ExecResult> {
    const sub = cmd[0] === "git" ? cmd.slice(1).find((a) => !a.startsWith("-") && !a.includes("=")) : undefined;
    const script = cmd[0] === "sh" && cmd[1] === "-c" ? cmd[2] ?? "" : "";
    const netScript = /\bgit\s+(push|clone|ls-remote|pull)\b/.test(script) || /\bgit\s+fetch\b(?![^\n]*capcomd-in-)/.test(script);
    if ((sub && NET.test(sub)) || netScript) {
      this.credentialed++;
      return super.exec(id, cmd, { ...opts, env: { ...(opts?.env ?? {}), CAPCOMD_GIT_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN } });
    }
    return super.exec(id, cmd, opts);
  }
}

async function sandbox() {
  const p = new CredentialedSandbox({ hostExec: true });
  const { id } = await p.ensure({ idemKey: `cred-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await p.waitReady(id, 1000);
  return { p, id };
}

/** Where planted commands write the env they ran with. */
function leakDir() { const d = mkdtempSync(join(tmpdir(), "capcomd-leak-")); return d; }
const leaks = (d: string) => readdirSync(d).filter((f) => f.endsWith(".env")).map((f) => ({ f, text: readFileSync(join(d, f), "utf8") }));
const tokenSeen = (d: string) => leaks(d).filter((l) => l.text.includes(TOKEN)).map((l) => l.f);

const refsOf = async (bare: string) => (await new Git(bare).run(["for-each-ref", "--format=%(refname)"])).stdout.trim();

describe("the sandbox side: a planted checkout gets no token and can't redirect the host", () => {
  test("push, checkpoint push and fetch through the host: every vector at once", async () => {
    const r = await bareRepo();
    const evil = (await bareRepo()).bare;
    const leak = leakDir();
    const { p, id } = await sandbox();
    const work = mkdtempSync(join(tmpdir(), "capcomd-cred-box-"));
    const home = join(work, "home");
    const env = { HOME: home, PATH: `${join(home, "npm", "bin")}:${process.env.PATH}` };
    const box: SandboxGit = { exec: (cmd, o) => p.exec(id, cmd, { env, ...o }), upload: (a, d) => p.upload(id, a, d), download: (a) => p.download(id, a) };
    const h = { remote: r.bare, workdir: join(work, "host") };
    const dir = join(work, "repo");
    await sendToSandbox(h, box, dir, { branches: "all", checkout: "main" }, { fresh: true });
    await plant(dir, home, leak, evil, r.bare);
    // The agent's commit (its own hooks and filters run here, in its sandbox, without a token).
    writeFileSync(join(dir, "work.txt"), "agent work\n");
    const c = await box.exec(["sh", "-c", `cd '${dir}' && git add -A && git -c user.name=a -c user.email=a@a commit -qm work && git rev-parse HEAD`]);
    expect(c.code).toBe(0);
    const sha = c.stdout.trim().split("\n").pop()!;

    await pushFromSandbox(h, box, dir, { sha, ref: "refs/capcomd/checkpoints/agt-x", force: true, near: ["main"] });
    await pushFromSandbox(h, box, dir, { sha, ref: "refs/heads/capcomd/r/t", expect: null, near: ["main"] });
    await r.pushToMain("later.txt", "moved\n");
    const fetched = await sendToSandbox(h, box, dir, { branches: "all" });

    // Landed on the run's repository, not the evil one; the fetch brought the moved main.
    expect(await r.sha("refs/heads/capcomd/r/t")).toBe(sha);
    expect(await r.sha("refs/capcomd/checkpoints/agt-x")).toBe(sha);
    expect(await refsOf(evil)).toBe("refs/heads/main");
    expect(fetched.heads.main).toBe((await r.sha("main"))!);
    expect((await new Git(dir).ok(["rev-parse", "refs/remotes/origin/main"])).trim()).toBe((await r.sha("main"))!);
    // No network git ran in the sandbox, so the credentialed provider never handed out the token, and nothing planted
    // ever saw it (the sandbox's own hooks and filters did run, without it).
    expect(p.credentialed).toBe(0);
    expect(tokenSeen(leak)).toEqual([]);
    expect(leaks(leak).some((l) => l.f.startsWith("hook-") || l.f.startsWith("clean."))).toBe(true);
    // Nothing on the host sent "stolen" credentials or talked to the planted helpers, ssh, askpass or packs.
    for (const f of ["helper", "ssh", "askpass", "receivepack", "uploadpack", "included-helper"]) expect(leaks(leak).filter((l) => l.f.startsWith(`${f}.`)).map((l) => l.f)).toEqual([]);
  }, 60_000);

  test("the runner end to end: a malicious agent plants every vector, the host still pushes its branch to the run's repository", async () => {
    const r = await bareRepo();
    const evil = (await bareRepo()).bare;
    const leak = leakDir();
    const workdir = mkdtempSync(join(tmpdir(), "capcomd-cred-agent-"));
    const cfg0 = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_POLL_MS: "50" });
    const home = agentHome(cfg0);
    // The "agent": plants everything in its checkout (its cwd) and HOME, then does the fake claude's work.
    const agent = join(workdir, "malicious-claude.sh");
    const plantScript = join(workdir, "plant.ts");
    writeFileSync(plantScript, `import { plant } from ${JSON.stringify(join(import.meta.dir, "..", "helpers", "plant-git-vectors.ts"))};\nawait plant(process.cwd(), ${JSON.stringify(home)}, ${JSON.stringify(leak)}, ${JSON.stringify(evil)}, ${JSON.stringify(r.bare)});\n`);
    writeFileSync(agent, `#!/bin/sh\n${JSON.stringify(process.execPath)} ${JSON.stringify(plantScript)} >/dev/null 2>&1 || echo plant-failed >&2\nexec ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`);
    chmodSync(agent, 0o755);
    const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: agent, CAPCOMD_AGENT_POLL_MS: "50" });
    const { p, id } = await sandbox();
    const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "[steady] make the failing test pass" };
    const res = await runClaudeCode(p, id, task, cfg, { apiKey: "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz", hostGit: { workdir: join(workdir, "host") } });
    expect(existsSync(join(leak, "helper.sh"))).toBe(true); // it did plant
    expect(await r.sha(`refs/heads/${task.branch}`)).toBe(res.sha);
    expect(await refsOf(evil)).toBe("refs/heads/main");
    expect(p.credentialed).toBe(0);
    expect(tokenSeen(leak)).toEqual([]);
    // The trace still says what git did (docs/integration-agents.md: a run's trace has `git.push` spans), run by the host.
    const git = getFinishedSpans().filter((s) => s.name.startsWith("git."));
    expect(git.find((s) => s.name === "git.push" && s.attributes["git.ref"] === `HEAD:refs/heads/${task.branch}`)?.attributes["git.via"]).toBe("host");
    expect(git.some((s) => s.name === "git.clone")).toBe(true);
  }, 90_000);
});

describe("the host side: credentialed git only in a host repo capcomd made, by URL", () => {
  test("remoteGit refuses a repository capcomd didn't make, a remote's name, and the ext:: transport", async () => {
    const r = await bareRepo();
    const plain = mkdtempSync(join(tmpdir(), "capcomd-plain-"));
    await new Git(plain).ok(["init", "-q"]);
    await expect(remoteGit(new Git(plain), ["ls-remote", r.bare], r.bare)).rejects.toBeInstanceOf(HostRepoRefused);
    const own = await initHostRepo(mkdtempSync(join(tmpdir(), "capcomd-own-")));
    expect(await hostRepoProblems(own)).toEqual([]);
    await expect(remoteGit(own, ["fetch", "origin"], "origin")).rejects.toThrow("not a repository URL");
    await expect(remoteGit(own, ["fetch", "ext::sh -c touch% /tmp/x"], "ext::sh -c touch% /tmp/x")).rejects.toThrow("ext");
    await expect(remoteGit(own, ["fetch", "origin", "main"], r.bare)).rejects.toThrow("URL in its arguments");
    expect((await remoteGit(own, ["ls-remote", r.bare], r.bare)).code).toBe(0);
  });

  const VECTORS: Array<[string, (dir: string, leak: string, evil: string, remote: string) => Promise<unknown> | void]> = [
    ["credential.helper", (d, l) => new Git(d).ok(["config", "credential.helper", `!${spy(l, "v")}`])],
    ["credential.<url>.helper", (d, l, _e, rm) => new Git(d).ok(["config", `credential.${rm}.helper`, `!${spy(l, "v")}`])],
    ["url.<evil>.insteadOf", (d, _l, e, rm) => new Git(d).ok(["config", `url.${e}.insteadOf`, rm])],
    ["url.<evil>.pushInsteadOf", (d, _l, e, rm) => new Git(d).ok(["config", `url.${e}.pushInsteadOf`, rm])],
    ["remote.origin.pushurl", (d, _l, e) => new Git(d).ok(["config", "remote.origin.pushurl", e])],
    ["core.sshCommand", (d, l) => new Git(d).ok(["config", "core.sshCommand", spy(l, "v")])],
    ["core.fsmonitor", (d, l) => new Git(d).ok(["config", "core.fsmonitor", spy(l, "v")])],
    ["core.hooksPath", (d, l) => new Git(d).ok(["config", "core.hooksPath", l])],
    ["core.askPass", (d, l) => new Git(d).ok(["config", "core.askPass", spy(l, "v")])],
    ["include.path", (d, l) => { writeFileSync(join(l, "inc"), `[credential]\n\thelper = !${spy(l, "v")}\n`); return new Git(d).ok(["config", "include.path", join(l, "inc")]); }],
    ["includeIf", (d, l) => { writeFileSync(join(l, "inc2"), `[core]\n\tsshCommand = ${spy(l, "v")}\n`); return new Git(d).ok(["config", `includeIf.gitdir:${d}/.path`, join(l, "inc2")]); }],
    ["http.proxy", (d) => new Git(d).ok(["config", "http.proxy", "http://127.0.0.1:9/"])],
    ["remote.origin.receivepack", (d, l) => new Git(d).ok(["config", "remote.origin.receivepack", spy(l, "v")])],
    ["a new pre-push hook", (d, l) => { const h = join(d, ".git", "hooks", "pre-push"); writeFileSync(h, `#!/bin/sh\nenv > "${l}/v.$$.env"\n`); chmodSync(h, 0o755); }],
    ["alternates", (d, l) => { mkdirSync(join(d, ".git", "objects", "info"), { recursive: true }); writeFileSync(join(d, ".git", "objects", "info", "alternates"), `${l}\n`); }],
  ];

  for (const [name, put] of VECTORS) test(`a clone with ${name} planted (a host check's code wrote it): refused, nothing pushed, nothing run`, async () => {
    const r = await bareRepo();
    const evil = (await bareRepo()).bare;
    const leak = leakDir();
    const dir = mkdtempSync(join(tmpdir(), "capcomd-hostrepo-"));
    const git = await initHostRepo(dir);
    await git.ok(["remote", "add", "origin", r.bare]);
    expect((await remoteGit(git, ["fetch", "-q", r.bare, "+refs/heads/*:refs/remotes/origin/*"], r.bare)).code).toBe(0);
    await put(dir, leak, evil, r.bare);
    const sha = (await git.ok(["rev-parse", "refs/remotes/origin/main"])).trim();
    const err = await remoteGit(git, ["push", "--porcelain", r.bare, `${sha}:refs/heads/stolen`], r.bare).catch((e) => e);
    expect(err).toBeInstanceOf(HostRepoRefused);
    expect(await r.sha("refs/heads/stolen")).toBeNull();
    expect(await refsOf(evil)).toBe("refs/heads/main");
    expect(leaks(leak).filter((l) => l.f.endsWith(".env"))).toEqual([]);
  });

  test("lsRemote reads no repository's settings: a checkout's insteadOf doesn't move it", async () => {
    const r = await bareRepo();
    const evil = (await bareRepo()).bare;
    await new Git(evil).ok(["update-ref", "refs/heads/only-in-evil", (await new Git(evil).revParse("main"))!]);
    const cwd = process.cwd();
    const trap = mkdtempSync(join(tmpdir(), "capcomd-trap-"));
    await new Git(trap).ok(["init", "-q"]);
    await new Git(trap).ok(["config", `url.${evil}.insteadOf`, r.bare]);
    process.chdir(trap);
    try {
      const l = await lsRemote(r.bare, ["--heads"]);
      expect(l.code).toBe(0);
      expect(l.stdout).toContain("refs/heads/main");
      expect(l.stdout).not.toContain("only-in-evil");
    } finally { process.chdir(cwd); }
  });

  test("the GitHub token is never handed to the user's own credential helpers to store (macOS git lists osxkeychain)", async () => {
    // A user helper (as osxkeychain, in the system config) that records every request; git hands a credential that
    // worked to every listed helper with `store`. No system config here, so the real keychain is never touched.
    const home = mkdtempSync(join(tmpdir(), "capcomd-home-"));
    const log = join(home, "user-helper.log");
    const helper = join(home, "user-helper.sh");
    writeFileSync(helper, `#!/bin/sh\necho "op=$1" >> "${log}"\ncat >> "${log}"\n`);
    chmodSync(helper, 0o755);
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`);
    const env = { ...(await hostCredentialEnv("https://github.com/o/r.git", {})), HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
    const git = (op: string, input: string) => {
      const p = Bun.spawnSync(["git", "credential", op], { cwd: home, env: { PATH: process.env.PATH!, ...env }, stdin: new TextEncoder().encode(input) });
      return { code: p.exitCode, out: p.stdout.toString() };
    };
    // What git does around an https push: fill, then (it worked) approve.
    const filled = git("fill", "protocol=https\nhost=github.com\npath=o/r.git\n\n");
    expect(filled.code).toBe(0);
    expect(filled.out).toContain(`password=${TOKEN}`);
    expect(git("approve", filled.out + "\n").code).toBe(0);
    const seen = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toContain("op=store");
    // Another host still gets the user's own helper.
    expect(git("fill", "protocol=https\nhost=gitlab.com\n\n").out).not.toContain(TOKEN);
    expect(readFileSync(log, "utf8")).toContain("host=gitlab.com");
  });

  test("a merge whose host-run checks plant a pushInsteadOf and a pre-push hook in the shared clone: refused, nothing lands anywhere", async () => {
    const r = await bareRepo();
    const evil = (await bareRepo()).bare;
    const leak = leakDir();
    const hook = `#!/bin/sh\\nenv > ${leak}/prepush.$$.env\\n`;
    // The check command is the checked code (an agent's): on the host (CAPCOMD_CHECKS=host, or a test sandbox) it can
    // write the clone's settings through the worktree it runs in.
    const plantCheck = `G=$(git rev-parse --git-common-dir) && git config --file "$G/config" url.${evil}.pushInsteadOf ${r.bare} && printf '${hook}' > "$G/hooks/pre-push" && chmod +x "$G/hooks/pre-push"`;
    const branch = taskBranch("rc", "t");
    await produceFakeWork(r.cfg, { runId: "rc", taskId: "t", branch, target: "main", epoch: 1 });
    const before = await r.sha("main");
    const out = await directMerge(r.cfg, { runId: "rc", taskId: "t", branch, target: "main", testCommand: plantCheck } as any, "rc", {}, new GitForge());
    expect(out.status).toBe("failed");
    expect((out as { reason?: string }).reason).toContain("won't run credentialed git");
    expect(await r.sha("main")).toBe(before);
    expect(await refsOf(evil)).toBe("refs/heads/main");
    expect(readdirSync(leak)).toEqual([]);
  }, 60_000);
});
