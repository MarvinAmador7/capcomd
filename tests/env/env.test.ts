import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { loadAgentConfig, CODEX_VERSION } from "../../src/agents/config";
import { envBuild, envRm, envStatus, lastVersion } from "../../src/env/build";
import { envName, readLedger, resolveEnvSnapshot, ENV_PREFIX } from "../../src/env/resolve";
import { doctor, formatDoctor } from "../../src/env/doctor";
import { secretsSync } from "../../src/env/secrets";
import { runAgent } from "../../src/agents/runner";
import { codexAdapter } from "../../src/agents/adapters";
import { taskBranch } from "../../src/merge/config";
import { getFinishedSpans, resetSpans } from "../../src/utils/tracing-simple";

const sh = (p: string, body: string) => { writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); };

/** A host-exec "VM" whose image has node + claude but no codex; npm is a fake that installs stubs. */
async function fixture(opts: { lock?: boolean } = {}) {
  const r = await bareRepo();
  if (opts.lock !== false) await r.pushToMain("package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-envb-"));
  const home = join(workdir, "home");
  mkdirSync(join(home, "node/bin"), { recursive: true });
  mkdirSync(join(home, "npm/bin"), { recursive: true });
  sh(join(home, "node/bin/node"), `case "$1" in -v) echo v22.9.0;; -p) echo 22;; esac`);
  sh(join(home, "node/bin/npm"), `
if [ "$1" = ci ]; then mkdir -p node_modules/leftpad && echo ok > node_modules/leftpad/index.js; exit 0; fi
prefix=; pkg=; while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; @*|[a-z]*@[0-9]*) pkg="$1"; shift;; *) shift;; esac; done
name=$(echo "$pkg" | sed -E 's#^@[^/]+/##; s#@.*$##'); ver=\${pkg##*@}; [ "$name" = claude-code ] && name=claude
mkdir -p "$prefix/bin"; printf '#!/bin/sh\\necho "%s-cli %s"\\n' "$name" "$ver" > "$prefix/bin/$name"; chmod +x "$prefix/bin/$name"`);
  sh(join(home, "npm/bin/claude"), `echo "2.1.290 (Claude Code)"`);
  const provider = new FakeProvider({ hostExec: true });
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir });
  return { r, provider, cfg, home, workdir, ledger: join(workdir, "envs.json") };
}

describe("capcomd env build|status|rm", () => {
  test("detects what the image has, installs only what is missing (pinned), bakes deps, snapshots, no secrets", async () => {
    const f = await fixture();
    const logs: string[] = [];
    const res = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, log: (l) => logs.push(l), pollMs: 1 });
    expect(res.cached).toBe(false);
    expect(res.name).toStartWith(ENV_PREFIX);
    expect(res.name).toBe(envName(res.record.manifest));
    expect(res.record.versions.claude).toEqual({ version: "2.1.290", source: "image" }); // kept, not reinstalled
    expect(res.record.versions.codex).toEqual({ version: CODEX_VERSION, source: "installed" });
    expect(res.record.versions.node!.source).toBe("image");
    expect(res.record.manifest.lockFile).toBe("package-lock.json");
    expect(res.record.depsInstalled).toBe(true);
    expect(existsSync(join(f.workdir, "template/node_modules/leftpad/index.js"))).toBe(true);
    expect(readFileSync(join(f.workdir, "template/.capcomd-lockhash"), "utf8")).toBe(res.record.manifest.lockHash);
    expect(readFileSync(join(f.home, ".gitconfig"), "utf8")).toContain("capcomd@users.noreply.github.com");
    expect(f.provider.snapshots.get(res.name)!.status).toBe("ready");
    expect(logs.join("\n")).toContain("scrub: clean");
    expect(readLedger(f.ledger).current!.name).toBe(res.name);
    // Build VM destroyed afterwards.
    expect(await f.provider.list("")).toEqual([]);

    // Same pins + lockfile → same name → cached; --force rebuilds.
    const again = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1 });
    expect(again).toMatchObject({ cached: true, name: res.name });
    expect((await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, force: true, pollMs: 1 })).cached).toBe(false);

    // Lockfile change → new content hash.
    await f.r.pushToMain("package-lock.json", '{"lockfileVersion":3,"packages":{"x":{}}}\n');
    const changed = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1 });
    expect(changed.name).not.toBe(res.name);

    const st = await envStatus(f.provider, f.ledger);
    expect(st.snapshots.map((s) => s.name).sort()).toEqual([res.name, changed.name].sort());
    expect(st.snapshots.find((s) => s.current)!.name).toBe(changed.name);
    expect(await envRm(f.provider, undefined, f.ledger)).toEqual([changed.name]);
    expect(readLedger(f.ledger).current).toBeUndefined();
    expect(await envRm(f.provider, "all", f.ledger)).toEqual([res.name]);
    await expect(envRm(f.provider, "not-ours", f.ledger)).rejects.toThrow("not a capcomd env snapshot");
  }, 60_000);

  test("refuses to snapshot when credential-shaped data or a local key value is in the VM", async () => {
    const f = await fixture({ lock: false });
    writeFileSync(join(f.home, ".npmrc"), "//registry.npmjs.org/:_authToken=ghp_abcdefghijklmnopqrstuvwxyz0123\n");
    await expect(envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1 })).rejects.toThrow("credential-shaped");
    expect(f.provider.snapshots.size).toBe(0);
    const g = await fixture({ lock: false });
    const local = "plainlocalvalue-0123456789";
    writeFileSync(join(g.home, "notes.txt"), local);
    const err = await envBuild(g.provider, { repoUrl: g.r.bare, cfg: g.cfg, ledgerPath: g.ledger, pollMs: 1, forbidden: [local] }).catch((e) => e);
    expect(err.message).toContain("local API key value is present");
    expect(err.message).not.toContain(local);
    expect(g.provider.snapshots.size).toBe(0);
  }, 60_000);

  test("no repo: CLIs + git config only; name depends on pins + lockfile, not the repo", async () => {
    const f = await fixture({ lock: false });
    const a = await envBuild(f.provider, { cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1 });
    expect(a.record.manifest).toMatchObject({ lockFile: "none", lockHash: "none", repo: "" });
    expect(a.record.depsInstalled).toBe(false);
    const b = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1 });
    expect(b).toMatchObject({ cached: true, name: a.name }); // lockfile-less repo → same snapshot
    const pinned = await envBuild(f.provider, { cfg: loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: f.workdir, CAPCOMD_CODEX_VERSION: "0.164.0" }), ledgerPath: f.ledger, pollMs: 1 });
    expect(pinned.name).not.toBe(a.name);
  }, 60_000);

  test("workers resolve the snapshot: ledger, explicit name, or forced image", async () => {
    const f = await fixture();
    const res = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1 });
    expect(resolveEnvSnapshot({ CAPCOMD_ENV_LEDGER: f.ledger, CAPCOMD_REPO: f.r.bare })).toBe(res.name);
    expect(resolveEnvSnapshot({ CAPCOMD_ENV_LEDGER: f.ledger, CAPCOMD_REPO: "/some/other.git" })).toBe(res.name);
    expect(resolveEnvSnapshot({ CAPCOMD_ENV_LEDGER: f.ledger, CAPCOMD_ENV: "image" })).toBeUndefined();
    expect(resolveEnvSnapshot({ CAPCOMD_ENV_LEDGER: join(f.workdir, "nope.json"), CAPCOMD_ENV_SNAPSHOT: "capcomd-env-x" })).toBe("capcomd-env-x");
    expect(resolveEnvSnapshot({ CAPCOMD_ENV_LEDGER: join(f.workdir, "nope.json") })).toBeUndefined();
  }, 60_000);
});

test("a worker on the snapshot reuses the baked node_modules when the lockfile matches", async () => {
  const f = await fixture();
  await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1 });
  resetSpans();
  const { id } = await f.provider.ensure({ idemKey: "w1", isolated: true, ttlSeconds: 60, egressAllow: ["github.com"], labels: {}, fromSnapshot: "x" });
  await f.provider.waitReady(id, 1000);
  const cfg = loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AGENT_WORKDIR: f.workdir, CAPCOMD_AGENT_BIN: new URL("../agents/fake-codex.sh", import.meta.url).pathname, CAPCOMD_AGENT_POLL_MS: "50", CAPCOMD_CREDENTIALS: "env" });
  const res = await runAgent(codexAdapter, f.provider, id, { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: f.r.bare, goal: "fix" }, cfg, { apiKey: "sk-proj-x-0123456789abcdef" });
  expect(getFinishedSpans().find((s) => s.name === "agent.codex")!.events.map((e) => e.name)).toContain("agent.deps_reused");
  // This image's node is a stub that runs no code: the agent runs without the supervisor (ADR-019), as before.
  expect(getFinishedSpans().find((s) => s.name === "agent.codex")!.attributes["agent.supervised"]).toBe(false);
  expect(existsSync(join(f.workdir, "task-1-e1/repo/node_modules/leftpad/index.js"))).toBe(true);
  // node_modules is excluded, never committed.
  const { Git } = await import("../../src/merge/git");
  expect((await new Git(f.r.bare).run(["show", "--stat", "--format=", res.sha])).stdout).not.toContain("node_modules");
}, 30_000);

describe("a warm template (Docker)", () => {
  test("full history of the target, deps installed, its record in .git; agents use it in place", async () => {
    const f = await fixture();
    const logs: string[] = [];
    const res = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, log: (l) => logs.push(l), pollMs: 1, warm: true, target: "main" });
    const T = join(f.workdir, "template");
    const { Git } = await import("../../src/merge/git");
    const main = (await f.r.sha("refs/heads/main"))!;
    expect(res.record.manifest.template).toEqual({ commit: main, target: "main" });
    expect(res.record.depsInstalled).toBe(true);
    // Not shallow: the whole history is there to branch and rebase on.
    expect((await new Git(T).ok(["rev-parse", "--is-shallow-repository"])).trim()).toBe("false");
    expect(Number((await new Git(T).ok(["rev-list", "--count", "HEAD"])).trim())).toBe(2);
    const marker = JSON.parse(readFileSync(join(T, ".git/capcomd-template.json"), "utf8"));
    expect(marker).toEqual({ schema: 1, repo: f.r.bare, target: "main", commit: main, lockFile: "package-lock.json", lockHash: res.record.manifest.lockHash, depsInstalled: true });
    // The hash lives in .git (out of the tree agents commit from), and node_modules is excluded: the checkout is clean.
    expect(readFileSync(join(T, ".git/capcomd-lockhash"), "utf8")).toBe(res.record.manifest.lockHash);
    expect(existsSync(join(T, ".capcomd-lockhash"))).toBe(false);
    expect((await new Git(T).ok(["status", "--porcelain"])).trim()).toBe("");
    expect(logs.join("\n")).toContain("warm template: main at");
    expect(logs.join("\n")).toContain("scrub: clean");
    // The commit is part of the image's name: a rebuild after main moved is a new image, not "up to date".
    const shallow = await envBuild(new FakeProvider({ hostExec: true }), { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: join(f.workdir, "other.json"), pollMs: 1 });
    expect(shallow.name).not.toBe(res.name);
    await f.r.pushToMain("later.txt", "later\n");
    const moved = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1, warm: true, target: "main" });
    expect(moved.cached).toBe(false);
    expect(moved.name).not.toBe(res.name);

    // A worker in that image works in the template in place, with its dependencies, and pushes its branch.
    resetSpans();
    const { id } = await f.provider.ensure({ idemKey: "w-warm", isolated: true, ttlSeconds: 60, egressAllow: ["github.com"], labels: {}, fromSnapshot: moved.name });
    await f.provider.waitReady(id, 1000);
    const cfg = loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AGENT_WORKDIR: f.workdir, CAPCOMD_AGENT_BIN: new URL("../agents/fake-codex.sh", import.meta.url).pathname, CAPCOMD_AGENT_POLL_MS: "50", CAPCOMD_CREDENTIALS: "env" });
    const run = await runAgent(codexAdapter, f.provider, id, { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: f.r.bare, goal: "fix" }, cfg, { apiKey: "sk-proj-x-0123456789abcdef", warmTemplate: true });
    const span = getFinishedSpans().find((s) => s.name === "agent.codex")!;
    expect(span.attributes["agent.workspace"]).toBe("in_place");
    expect(span.events.map((e) => e.name)).toContain("agent.deps_reused");
    expect(existsSync(join(f.workdir, "task-1-e1/repo"))).toBe(false);
    expect((await new Git(f.r.bare).run(["show", "--stat", "--format=", run.sha])).stdout).not.toContain("node_modules");
    expect((await new Git(f.r.bare).ok(["rev-parse", `${run.sha}^`])).trim()).toBe((await f.r.sha("refs/heads/main"))!);
  }, 60_000);

  test("a bun.lock project on an image without bun: the pinned bun is installed, then the frozen install", async () => {
    const f = await fixture({ lock: false });
    await f.r.pushToMain("bun.lock", '{"lockfileVersion":1}\n');
    await f.r.pushToMain(".bun-version", "1.4.2\n");
    const logs: string[] = [];
    const res = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, log: (l) => logs.push(l), pollMs: 1, warm: true, target: "main" });
    expect(logs.join("\n")).toContain("bun not in image → installing bun@1.4.2");
    expect(readFileSync(join(f.home, "npm/bin/bun"), "utf8")).toContain("bun-cli 1.4.2");
    expect(logs.join("\n")).toContain("deps: bun install --frozen-lockfile ok");
    expect(res.record.depsInstalled).toBe(true);
  }, 60_000);
});

describe("capcomd doctor", () => {
  test("reports CLI versions, placeholder-in-VM, and API acceptance through substitution", async () => {
    const f = await fixture();
    await secretsSync(f.provider, { ANTHROPIC_API_KEY: "sk-ant-api03-DOCKEY-0123456789abcdefghijkl" });
    // Fake curl: 200 only when the header carries the anthropic placeholder (boxd would substitute it).
    const ph = f.provider.machineEnv().ANTHROPIC_API_KEY!;
    const curl = join(f.workdir, "curl");
    sh(curl, `for a in "$@"; do case "$a" in *${ph}*) printf 200; exit 0;; esac; done; printf 401`);
    const rep = await doctor(f.provider, { cfg: f.cfg, snapshot: "capcomd-env-abc", source: {}, curlBin: curl });
    const claude = rep.agents.find((a) => a.agent === "claude-code")!;
    const codex = rep.agents.find((a) => a.agent === "codex")!;
    expect(claude).toMatchObject({ ok: true, cli: { ok: true, version: "2.1.290" }, credential: { mode: "placeholder", via: "secret" }, api: { ok: true, status: 200 } });
    expect(codex).toMatchObject({ ok: false, cli: { ok: false }, credential: { mode: "absent", via: "none" } });
    expect(formatDoctor(rep)).toContain("key-in-vm=placeholder");
    expect(JSON.stringify(rep)).not.toContain("DOCKEY");
    expect(await f.provider.list("")).toEqual([]);
  }, 30_000);
});

test("installed CLI version is the transcript's last x.y.z (node's download version comes first)", () => {
  const transcript = "fetching https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.gz\nadded 3 packages in 2s\n2.1.286 (Claude Code)\n";
  expect(lastVersion(transcript)).toBe("2.1.286");
  expect(lastVersion("v26.12.0\n")).toBe("26.12.0");
  expect(lastVersion("Executed: sh -c command -v node >/dev/null && node -v; true")).toBeUndefined();
});

describe("the project's brains in the env image (ADR-025 step 4)", () => {
  const ACME_ID = "urn:uuid:6e7cc12e-b3f7-49da-875d-32b714fdc1e8";
  const item = (id: string, sensitivity?: string) => `---\ntype: policy\nid: ${id}\ntitle: Refund window\ndescription: Refunds within 30 days\nstatus: stable\n${sensitivity ? `sensitivity: ${sensitivity}\n` : ""}---\n\nBody.\n`;
  /** A groundray brain in a bare repository, with a restricted file outside its bundle. */
  async function brainRepo(extra: Record<string, string> = {}) {
    const b = await bareRepo();
    const files: Record<string, string> = {
      "brain.yaml": `schema_version: 1\nid: ${ACME_ID}\nslug: acme\nname: acme fictional\nbundle: knowledge\n`,
      "knowledge/.core-kb.yaml": "default_sensitivity: internal\n",
      "knowledge/policies/refunds.md": item("refunds"),
      "knowledge/references/capture.txt": "raw capture\n",
      "private/salaries.md": item("pay", "restricted"),
      ...extra,
    };
    for (const [p, text] of Object.entries(files)) { mkdirSync(join(b.root, "seed", p, ".."), { recursive: true }); writeFileSync(join(b.root, "seed", p), text); }
    await b.seed.ok(["add", "."]);
    await b.seed.ok(["commit", "-q", "-m", "brain"]);
    await b.seed.ok(["push", "-q", "origin", "main"]);
    return { b, commit: (await b.sha("main"))! };
  }
  const listed = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? listed(join(dir, e.name)).map((x) => `${e.name}/${x}`) : [e.name]).sort();

  test("env build places each mapped brain's bundle at its pinned commit, with the marker; an agent's runner keeps it and sends nothing at start", async () => {
    const f = await fixture({ lock: false });
    const { b, commit } = await brainRepo();
    const { mappedBundles } = await import("../../src/context/groundray");
    const settings = { brains: { acme: { repo: b.bare, branch: "main", commit, slug: "acme", id: ACME_ID } } };
    const { bundles, skipped } = await mappedBundles(settings, f.cfg.workdir);
    expect(skipped).toEqual([]);
    const dir = join(f.workdir, "context/groundray/acme");
    expect(bundles).toEqual([{ provider: "groundray", name: "acme", remote: b.bare, branch: "main", commit, path: "knowledge", dir }]);
    const hostGit = { workdir: join(f.workdir, "host-git") };
    const plain = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1, hostGit });
    expect(existsSync(dir)).toBe(false);
    const logs: string[] = [];
    const res = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1, hostGit, bundles, log: (l) => logs.push(l) });
    // The bundles are part of the image's name and record.
    expect(res.cached).toBe(false);
    expect(res.name).not.toBe(plain.name);
    expect(res.name).toBe(envName(res.record.manifest));
    expect(res.record.manifest.bundles).toEqual([{ provider: "groundray", name: "acme", commit, path: "knowledge" }]);
    expect(logs.join("\n")).toContain(`context: placed groundray acme (knowledge/) at ${commit.slice(0, 12)}`);
    // Only the bundle's directory, read-only, with the marker: nothing else of the brain's repository.
    expect(listed(dir)).toEqual([".capcomd-bundle", "knowledge/.core-kb.yaml", "knowledge/policies/refunds.md", "knowledge/references/capture.txt"]);
    expect(readFileSync(join(dir, ".capcomd-bundle"), "utf8")).toBe(`${commit} knowledge`);
    expect(statSync(join(dir, "knowledge/policies/refunds.md")).mode & 0o222).toBe(0);
    // Mapped again at a newer commit: a new image.
    await b.pushToMain("knowledge/policies/later.md", item("later"));
    const later = (await b.sha("main"))!;
    const moved = (await mappedBundles({ brains: { acme: { ...settings.brains.acme, commit: later } } }, f.cfg.workdir)).bundles;
    expect(moved[0]!.commit).toBe(later);
    expect(envName({ ...res.record.manifest, bundles: moved.map((x) => ({ provider: x.provider, name: x.name, commit: x.commit, path: x.path })) })).not.toBe(res.name);

    // A worker booted from the image: the runner finds the bundle at its commit and keeps it; nothing is uploaded for it.
    // An image's bundle its brief doesn't cite goes before the agent starts.
    mkdirSync(join(f.workdir, "context/groundray/globex/knowledge"), { recursive: true });
    writeFileSync(join(f.workdir, "context/groundray/globex/knowledge/a.md"), "GLOBEX-ONLY\n");
    resetSpans();
    const uploads: string[] = [];
    const upload = f.provider.upload.bind(f.provider);
    f.provider.upload = async (vm, path, data) => { uploads.push(path); return upload(vm, path, data); };
    const { id } = await f.provider.ensure({ idemKey: "w-brain", isolated: true, ttlSeconds: 60, egressAllow: ["github.com"], labels: {}, fromSnapshot: res.name });
    await f.provider.waitReady(id, 1000);
    const cfg = { ...loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AGENT_WORKDIR: f.workdir, CAPCOMD_AGENT_BIN: new URL("../agents/fake-codex.sh", import.meta.url).pathname, CAPCOMD_AGENT_POLL_MS: "50", CAPCOMD_CREDENTIALS: "env" }), contextBundles: bundles };
    const lines: string[] = [];
    await runAgent(codexAdapter, f.provider, id, { runId: "r1", taskId: "task-b", epoch: 1, branch: taskBranch("r1", "task-b"), target: "main", repoUrl: f.r.bare, goal: "fix" }, cfg, { apiKey: "sk-proj-x-0123456789abcdef", hostGit, onLog: (l) => lines.push(...l) });
    const events = getFinishedSpans().find((s) => s.name === "agent.codex")!.events.filter((e) => e.name === "agent.context_bundle");
    expect(events.map((e) => e.attributes?.["context.placed"])).toEqual(["kept"]);
    expect(lines.join("\n")).toContain(`context: groundray acme (knowledge/) at ${commit.slice(0, 12)} is already in ${dir}`);
    expect(uploads.filter((p) => p.includes("capcomd-tree-"))).toEqual([]);
    expect(existsSync(join(f.workdir, "context/groundray/globex"))).toBe(false);
    expect(listed(dir)).toContain("knowledge/policies/refunds.md");
  }, 90_000);

  test("a brain that is restricted, or isn't the brain it was mapped as, stays out of the image; one with credential-shaped text in it is left out", async () => {
    const f = await fixture({ lock: false });
    const { mappedBundles } = await import("../../src/context/groundray");
    const vault = await brainRepo({ "knowledge/references/payroll.yaml": "sensitivity: restricted\n" });
    const other = await brainRepo();
    const { bundles, skipped } = await mappedBundles({ brains: {
      vault: { repo: vault.b.bare, branch: "main", commit: vault.commit, slug: "acme", id: ACME_ID },
      renamed: { repo: other.b.bare, branch: "main", commit: other.commit, slug: "globex", id: ACME_ID },
    } }, f.cfg.workdir);
    expect(bundles).toEqual([]);
    expect(skipped.map((s) => s.name)).toEqual(["renamed", "vault"]);
    expect(skipped[0]!.why).toContain("isn't the brain it was at");
    expect(skipped[1]!.why).toContain("restricted");
    // Credential-shaped text in a brain is the brain's: the image doesn't carry it (the runner places it at start).
    const leaky = await brainRepo({ "knowledge/references/setup.txt": "token ghp_abcdefghijklmnopqrstuvwxyz0123\n" });
    const ok = (await mappedBundles({ brains: { leaky: { repo: leaky.b.bare, branch: "main", commit: leaky.commit, slug: "acme", id: ACME_ID } } }, f.cfg.workdir)).bundles;
    expect(ok.map((x) => x.name)).toEqual(["leaky"]);
    const logs: string[] = [];
    const res = await envBuild(f.provider, { repoUrl: f.r.bare, cfg: f.cfg, ledgerPath: f.ledger, pollMs: 1, hostGit: { workdir: join(f.workdir, "host-git") }, bundles: ok, log: (l) => logs.push(l) });
    expect(logs.join("\n")).toContain("context: left groundray leaky out of the image");
    expect(logs.join("\n")).toContain("scrub: clean");
    expect(existsSync(join(f.workdir, "context/groundray/leaky"))).toBe(false);
    expect(f.provider.snapshots.get(res.name)!.status).toBe("ready");
  }, 90_000);
});

