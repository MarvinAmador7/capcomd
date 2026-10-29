// Capability projects.git: POST /v1/projects/git-init, GET /v1/projects/publish-options and POST /v1/projects/publish take
// a plain folder to a GitHub checkout; POST /v1/projects takes no check (the suggested one) and `gitignore`. Real
// folders and git, a scratch HOME and CAPCOMD_HOME, and a FAKE gh (CAPCOMD_GH_CLI) whose `repo create` makes a local bare
// repository, adds it as origin, pushes, then points origin at the GitHub URL (never contacted). Never the real gh or
// GitHub. Engine-free (the memory source).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, EventData, ProjectInspect, ProjectPublishOptions } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { repoNameFor, secretReason } from "../../src/api/project-git";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { describeEvent } from "../../src/api/describe";
import spec from "../../openapi/capcomd.json";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-project-git-")));
const cpath = join(dir, "clients.json");
const configurer = addClient("menubar", ["read", "steer", "approve", "configure"], cpath);
const steerOnly = addClient("old-menubar", ["read", "steer", "approve"], cpath);
const IDENTITY = "[user]\n\tname = Test\n\temail = test@example.com\n";

const sh = (cmd: string[], cwd: string, home = join(dir, "sh-home")) => {
	mkdirSync(home, { recursive: true });
	if (!existsSync(join(home, ".gitconfig"))) writeFileSync(join(home, ".gitconfig"), IDENTITY);
	const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};

/** A fake `gh`: `api user` (marvin) and `api user/orgs` (acme, dnamic-labs); `repo create` pushes to a local bare repo
 *  under <gh>/remotes, or says the name exists when it's listed in <gh>/taken. Every call is logged in <gh>/calls. */
function fakeGh(): { bin: string; root: string } {
	const root = mkdtempSync(join(dir, "gh-"));
	const bin = join(root, "gh");
	writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${root}/calls"
case "$1" in
  api)
    case "$2" in
      user) echo '{"login":"marvin","id":1}' ;;
      user/orgs) echo '[{"login":"acme"},{"login":"dnamic-labs"}]' ;;
      *) echo "HTTP 404" >&2; exit 1 ;;
    esac ;;
  repo)
    full="$3"; shift 3; src=""
    while [ $# -gt 0 ]; do case "$1" in --source) src="$2"; shift 2 ;; *) shift ;; esac; done
    if grep -qx "$full" "${root}/taken" 2>/dev/null; then echo "GraphQL: Name already exists on this account (createRepository)" >&2; exit 1; fi
    bare="${root}/remotes/$full.git"
    mkdir -p "$bare" && git init -q --bare "$bare" && cd "$src" && git remote add origin "$bare" && git push -q -u origin HEAD 2>/dev/null \\
      && git remote set-url origin "https://github.com/$full.git" && echo "https://github.com/$full"
    ;;
  *) exit 1 ;;
esac
`);
	chmodSync(bin, 0o755);
	return { bin, root };
}

function world(o: { gh?: boolean; identity?: boolean } = {}) {
	const home = realpathSync(mkdtempSync(join(dir, "user-")));
	if (o.identity !== false) writeFileSync(join(home, ".gitconfig"), IDENTITY);
	const gh = fakeGh();
	const env = { HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), CAPCOMD_GH_CLI: gh.bin, GIT_CONFIG_NOSYSTEM: "1" };
	const src = memorySource({ projects: { env, ghReady: async () => o.gh ?? true } });
	const state = harnessState(null);
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state });
	const req = async (method: string, p: string, body?: unknown, o2: { token?: string; key?: string | null } = {}) => {
		const headers: Record<string, string> = { authorization: `Bearer ${o2.token ?? configurer.token}`, "content-type": "application/json" };
		if (method === "POST" && o2.key !== null) headers["idempotency-key"] = o2.key ?? `key-${Math.random().toString(36).slice(2)}`;
		const r = await app.request(p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
		return { status: r.status, body: (await r.json()) as any };
	};
	return {
		home, env, gh, state, req,
		inspect: (path: string) => req("GET", `/v1/projects/inspect?path=${encodeURIComponent(path)}`),
		init: (path: string, o2?: { token?: string; key?: string | null }) => req("POST", "/v1/projects/git-init", { path }, o2),
		options: (path: string) => req("GET", `/v1/projects/publish-options?path=${encodeURIComponent(path)}`),
		publish: (body: Record<string, unknown>, o2?: { token?: string; key?: string | null }) => req("POST", "/v1/projects/publish", { owner: "marvin", name: "my-app", visibility: "private", ...body }, o2),
		setup: (body: Record<string, unknown>) => req("POST", "/v1/projects", { mode: "direct", target: "main", agents: ["claude"], ...body }),
	};
}

/** A plain folder with some files (not a checkout). */
function folder(files: Record<string, string> = { "README.md": "hi\n", "src/index.ts": "export {}\n" }, name = "my-app"): string {
	const d = join(realpathSync(mkdtempSync(join(dir, "f-"))), name);
	for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); }
	mkdirSync(d, { recursive: true });
	return d;
}
/** A checkout with no origin: `git init` (and a commit when `commit`). */
function local(files?: Record<string, string>, o: { commit?: boolean } = {}): string {
	const d = folder(files);
	sh(["git", "init", "-q", "-b", "main"], d);
	if (o.commit) { sh(["git", "add", "-A"], d); sh(["git", "commit", "-qm", "work"], d); }
	return d;
}
const read = (f: string) => readFileSync(f, "utf8");

describe("POST /v1/projects/git-init", () => {
	test("starts a repository in a folder that isn't one (no commit); inspect then says no_origin; audited; replays", async () => {
		const w = world();
		const d = folder();
		expect((await w.inspect(d)).body.problems[0].code).toBe("not_git");
		const r = await w.init(d, { key: "init-key-0001" });
		expect(r.status).toBe(200);
		expect(ProjectInspect.parse(r.body)).toEqual(r.body);
		expect(r.body).toMatchObject({ path: d, root: d, name: "my-app", repo: null, github: null, branches: [], defaultBranch: "main" });
		expect(r.body.problems.map((p: any) => p.code)).toEqual(["no_origin"]);
		expect(existsSync(join(d, ".git"))).toBe(true);
		expect(sh(["git", "symbolic-ref", "--short", "HEAD"], d)).toBe("main");
		expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: d }).exitCode).not.toBe(0);   // no commit
		const evs = (await w.req("GET", "/v1/events?scope=daemon")).body as any[];
		expect(evs.length).toBe(1);
		expect(HarnessEvent.parse(evs[0])).toBeTruthy();
		expect(EventData["project.git_initialized"].parse(evs[0].data)).toBeTruthy();
		expect(evs[0]).toMatchObject({ type: "project.git_initialized", entity: "project:my-app", text: `Started a git repository in my-app (${d}), on branch main.`, data: { path: d, name: "my-app", branch: "main", clientId: configurer.client.id } });
		expect(describeEvent("project.git_initialized", {}, null)).toBe("A git repository was started in a folder.");
		// The same key replays the first answer and runs nothing again.
		expect(await w.init(d, { key: "init-key-0001" })).toEqual(r);
		expect(w.state.daemonEvents().length).toBe(1);
	});

	test("only for a folder inspect reports as not_git", async () => {
		const w = world();
		const co = local();
		expect(await w.init(co)).toEqual({ status: 409, body: { code: "conflict", message: `${co} is already in a git checkout (${co}). Look at the folder again.` } });
		mkdirSync(join(co, "sub"));
		expect((await w.init(join(co, "sub"))).body).toMatchObject({ code: "conflict" });
		expect(await w.init(join(dir, "nope"))).toMatchObject({ status: 422, body: { code: "invalid", field: "path", problem: "not_found" } });
		expect(await w.init(w.home)).toMatchObject({ status: 422, body: { field: "path", problem: "home" } });
		// A folder that holds the home folder, and /.
		expect(await w.init(dirname(w.home))).toMatchObject({ status: 422, body: { field: "path", problem: "home", message: `${dirname(w.home)} holds your home folder, so capcomd won't start a repository there. Choose your project's own folder.` } });
		expect(await w.init("/")).toMatchObject({ status: 422, body: { field: "path" } });
		expect(existsSync(join(dirname(w.home), ".git"))).toBe(false);
		// capcomd's own settings folder.
		mkdirSync(w.env.CAPCOMD_HOME, { recursive: true });
		expect(await w.init(w.env.CAPCOMD_HOME)).toMatchObject({ status: 422, body: { field: "path", problem: "home" } });
		expect(await w.init("relative/x")).toMatchObject({ status: 422, body: { code: "invalid", field: "path" } });
		expect(w.state.daemonEvents()).toEqual([]);
	});

	test("the configure scope and an Idempotency-Key", async () => {
		const w = world();
		const d = folder();
		expect(await w.init(d, { token: steerOnly.token })).toEqual({ status: 403, body: { code: "forbidden", message: "token lacks the configure scope" } });
		expect(await w.init(d, { key: null })).toEqual({ status: 422, body: { code: "invalid", message: "Idempotency-Key header (8-200 chars) is required" } });
		expect(existsSync(join(d, ".git"))).toBe(false);
	});
});

describe("GET /v1/projects/publish-options", () => {
	test("accounts (the gh user, then orgs), a name, the first commit's files and the likely secrets among them", async () => {
		const w = world();
		const d = local({
			"README.md": "hi\n", "src/a.ts": "1\n", ".env": "KEY=x\n", ".env.local": "x\n", ".env.example": "KEY=\n", "keys/id_rsa": "k\n", "keys/id_rsa.pub": "p\n",
			"cert.pem": "c\n", ".npmrc": "//registry.npmjs.org/:_authToken=npm_x\n", "web/.npmrc": "save-exact=true\n", ".gitignore": "dist/\n", "dist/out.js": "x\n",
		});
		const r = await w.options(d);
		expect(r.status).toBe(200);
		expect(ProjectPublishOptions.parse(r.body)).toEqual(r.body);
		expect(r.body).toMatchObject({
			path: d, root: d, ghReady: true, suggestedName: "my-app", hasCommits: false, branch: "main",
			accounts: [{ login: "marvin", kind: "user" }, { login: "acme", kind: "org" }, { login: "dnamic-labs", kind: "org" }],
			files: 11,   // dist/ is ignored
		});
		expect(r.body.blocked.map((b: any) => b.path).sort()).toEqual([".env", ".env.local", ".npmrc", "cert.pem", "keys/id_rsa"]);
		expect(r.body.blocked.find((b: any) => b.path === ".env").reason).toBe("an environment file, which usually holds secrets");
		// Cached: asked again within 30 s, gh isn't.
		await w.options(d);
		expect(read(join(w.gh.root, "calls")).trim().split("\n")).toEqual(["api user", "api user/orgs"]);
	});

	test("no gh login: ghReady false and no accounts (gh never asked); with commits: HEAD's files", async () => {
		const w = world({ gh: false });
		const d = local({ "a.txt": "a\n", "b.txt": "b\n" }, { commit: true });
		writeFileSync(join(d, "c.txt"), "c\n");
		const r = await w.options(d);
		expect(r.body).toMatchObject({ ghReady: false, accounts: [], hasCommits: true, files: 2, blocked: [] });
		expect(existsSync(join(w.gh.root, "calls"))).toBe(false);
	});

	test("only for a checkout without origin", async () => {
		const w = world();
		const plain = folder();
		expect(await w.options(plain)).toMatchObject({ status: 422, body: { code: "invalid", field: "path", problem: "not_git" } });
		const co = local({ "a.txt": "a\n" }, { commit: true });
		sh(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], co);
		expect(await w.options(co)).toEqual({ status: 409, body: { code: "conflict", message: `${co} is already on GitHub (acme/app), so there's nothing to publish.` } });
		expect(await w.options("relative")).toMatchObject({ status: 422, body: { field: "path" } });
	});

	test("names: the folder's name as GitHub takes it; secrets by name", () => {
		expect(repoNameFor("my-app")).toBe("my-app");
		expect(repoNameFor("My App (copy)")).toBe("My-App-copy");
		expect(repoNameFor("café ñu")).toBe("cafe-nu");
		expect(repoNameFor("..")).toBe("project");
		expect(repoNameFor("x".repeat(150)).length).toBe(100);
		expect(secretReason(".env.production", "/")).not.toBeNull();
		expect(secretReason(".env.sample", "/")).toBeNull();
		expect(secretReason("a/id_ed25519", "/")).toBe("an SSH private key");
		expect(secretReason("a/id_ed25519.pub", "/")).toBeNull();
		expect(secretReason("store.p12", "/")).not.toBeNull();
		expect(secretReason(".netrc", "/")).toBe("saved login credentials");
		expect(secretReason("src/env.ts", "/")).toBeNull();
	});
});

describe("POST /v1/projects/publish", () => {
	test("a folder from git-init: the first commit, the repository created and pushed; then it can be set up", async () => {
		const w = world();
		const d = folder({ "README.md": "hi\n", "src/index.ts": "export {}\n", "package.json": JSON.stringify({ scripts: { test: "bun test" } }), "bun.lock": "", ".gitignore": "node_modules/\n", "node_modules/x/i.js": "x\n" });
		expect((await w.init(d)).status).toBe(200);
		const r = await w.publish({ path: d }, { key: "publish-key-01" });
		expect(r.status).toBe(200);
		expect(ProjectInspect.parse(r.body)).toEqual(r.body);
		expect(r.body).toMatchObject({ root: d, repo: "https://github.com/marvin/my-app.git", github: "marvin/my-app", defaultBranch: "main", branches: ["main"], problems: [] });
		expect(read(join(w.gh.root, "calls"))).toContain(`repo create marvin/my-app --private --source ${d} --remote origin --push`);
		const bare = join(w.gh.root, "remotes", "marvin", "my-app.git");
		expect(sh(["git", "log", "--format=%s", "main"], bare)).toBe("Initial commit");
		expect(sh(["git", "ls-tree", "-r", "--name-only", "main"], bare).split("\n").sort()).toEqual([".gitignore", "README.md", "bun.lock", "package.json", "src/index.ts"]);
		const evs = (await w.req("GET", "/v1/events?scope=daemon")).body as any[];
		const pub = evs.find((e) => e.type === "project.published");
		expect(EventData["project.published"].parse(pub.data)).toBeTruthy();
		expect(pub).toMatchObject({
			entity: "project:my-app", text: `Published my-app (${d}) to github.com/marvin/my-app, private, with a first commit of 5 files.`,
			data: { path: d, name: "my-app", owner: "marvin", repo: "marvin/my-app", visibility: "private", firstCommit: true, files: 5, clientId: configurer.client.id },
		});
		expect(describeEvent("project.published", {}, null)).toBe("A project was published to GitHub.");
		// Replayed: the first answer, nothing created again.
		expect(await w.publish({ path: d }, { key: "publish-key-01" })).toEqual(r);
		expect(read(join(w.gh.root, "calls")).match(/repo create/g)!.length).toBe(1);
		// Published again with another key: it has an origin now.
		expect((await w.publish({ path: d })).body).toMatchObject({ code: "conflict" });
		// Set up: pull requests (gh is logged in), the check omitted → the suggested one.
		const s = await w.setup({ path: d, mode: "pr" });
		expect(s.status).toBe(200);
		expect(s.body.project.values).toMatchObject({ repo: "https://github.com/marvin/my-app.git", mode: "pr", check: "bun run test" });
	});

	test("a checkout with commits: pushed as it is (no new commit), public, to an organization", async () => {
		const w = world();
		const d = local({ "a.txt": "a\n", ".env": "SECRET=1\n" }, { commit: true });
		const head = sh(["git", "rev-parse", "HEAD"], d);
		const r = await w.publish({ path: d, owner: "acme", name: "tools", visibility: "public" });
		expect(r.status).toBe(200);
		expect(r.body.github).toBe("acme/tools");
		expect(sh(["git", "rev-parse", "HEAD"], d)).toBe(head);
		expect(read(join(w.gh.root, "calls"))).toContain("repo create acme/tools --public");
		expect(w.state.daemonEvents()[0]).toMatchObject({ text: `Published my-app (${d}) to github.com/acme/tools, public.`, data: { firstCommit: false, files: null } });
	});

	test("refusals, each with the daemon's sentence and field; nothing committed or created", async () => {
		const w = world();
		const noHead = (d: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: d }).exitCode !== 0;
		// Likely secrets in the first commit.
		const secrets = local({ "a.txt": "a\n", ".env": "KEY=1\n" });
		expect(await w.publish({ path: secrets })).toEqual({ status: 422, body: { code: "invalid", field: "files", message: ".env looks like it holds secrets, and the first commit would publish it. Add it to .gitignore, then publish again." } });
		expect(noHead(secrets)).toBe(true);
		// Ignored: then it publishes.
		writeFileSync(join(secrets, ".gitignore"), ".env\n");
		expect((await w.publish({ path: secrets, name: "secrets-ok" })).status).toBe(200);
		expect(sh(["git", "ls-tree", "-r", "--name-only", "HEAD"], secrets).split("\n").sort()).toEqual([".gitignore", "a.txt"]);
		// Too many files.
		const many: Record<string, string> = {};
		for (let i = 0; i < 2001; i++) many[`f/${i}.txt`] = "x";
		const big = local(many);
		expect(await w.publish({ path: big })).toEqual({ status: 422, body: { code: "invalid", field: "files", message: "The first commit would hold 2001 files (more than 2000), which usually means dependencies or build output are in it. Add a .gitignore for them, then publish again." } });
		// No files at all.
		const empty = local({});
		expect((await w.publish({ path: empty })).body).toMatchObject({ field: "files" });
		// The name is taken.
		writeFileSync(join(w.gh.root, "taken"), "marvin/taken\n");
		const t = local();
		expect(await w.publish({ path: t, name: "taken" })).toEqual({ status: 409, body: { code: "conflict", field: "name", message: "marvin/taken already exists on GitHub. Choose another name. The first commit is made; publishing again pushes it." } });
		expect(sh(["git", "log", "--format=%s"], t)).toBe("Initial commit");
		expect((await w.publish({ path: t, name: "free" })).status).toBe(200);   // again with another name: the commit is pushed
		// Bad names and owners.
		const n = local();
		expect((await w.publish({ path: n, name: "bad name" })).body).toMatchObject({ code: "invalid", field: "name" });
		expect((await w.publish({ path: n, name: ".." })).body).toMatchObject({ field: "name" });
		expect((await w.publish({ path: n, owner: "someone-else" })).body).toEqual({ code: "invalid", field: "owner", message: "The GitHub CLI isn't logged in as someone-else or a member of it: choose marvin, acme, dnamic-labs." });
		expect((await w.publish({ path: n, owner: "-x" })).body).toMatchObject({ field: "owner" });
		expect((await w.publish({ path: n, visibility: "internal" })).body).toMatchObject({ field: "visibility" });
		// Not a checkout without origin.
		expect((await w.publish({ path: folder() })).body).toMatchObject({ field: "path", problem: "not_git" });
		expect(noHead(n)).toBe(true);
		expect(read(join(w.gh.root, "calls")).match(/repo create/g)!.length).toBe(3);   // secrets-ok, taken, free
	});

	test("no gh login: refused with field gh; no git identity: refused with field identity", async () => {
		const off = world({ gh: false });
		const d = local();
		expect(await off.publish({ path: d })).toEqual({ status: 422, body: { code: "invalid", field: "gh", message: "Publishing needs the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), then publish again." } });
		const anon = world({ identity: false });
		const e = local();
		const r = await anon.publish({ path: e });
		expect(r).toMatchObject({ status: 422, body: { code: "invalid", field: "identity", message: expect.stringContaining("git doesn't know who you are") } });
		expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD"], { cwd: e }).exitCode).not.toBe(0);
		expect(anon.state.daemonEvents()).toEqual([]);
	});

	test("the configure scope; advertised and published in the contract", async () => {
		const w = world();
		const d = local();
		expect(await w.publish({ path: d }, { token: steerOnly.token })).toEqual({ status: 403, body: { code: "forbidden", message: "token lacks the configure scope" } });
		expect(await w.publish({ path: d }, { key: null })).toMatchObject({ status: 422 });
		expect(CAPABILITY_NAMES).toContain("projects.git");
		const paths = (spec as any).paths;
		expect(Object.keys(paths["/v1/projects/publish"].post.responses)).toEqual(expect.arrayContaining(["200", "403", "409", "422", "503"]));
		expect(Object.keys(paths["/v1/projects/git-init"].post.responses)).toEqual(expect.arrayContaining(["200", "403", "409", "422"]));
		expect(paths["/v1/projects/publish-options"].get.parameters.find((x: any) => x.name === "path")).toMatchObject({ in: "query", required: true });
	});
});

describe("POST /v1/projects: check optional, gitignore", () => {
	/** A GitHub checkout (origin set, never contacted). */
	const github = (files?: Record<string, string>) => { const d = local(files ?? { "a.txt": "a\n" }, { commit: true }); sh(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], d); return d; };

	test("no check sent: the suggested one, none when there's nothing to suggest, the current one when set up", async () => {
		const w = world();
		const none = github();
		const r = await w.setup({ path: none });
		expect(r.status).toBe(200);
		expect(r.body.project.values.check).toBe("");
		expect(JSON.parse(read(join(none, ".capcomd", "config.json"))).run).toEqual({ reviewer: "reviewer" });
		const npm = github({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
		expect((await w.setup({ path: npm })).body.project.values.check).toBe("npm test");
		expect((await w.setup({ path: npm, check: "make check" })).body.project.values.check).toBe("make check");
		// Set up already: omitted keeps it.
		expect((await w.setup({ path: npm })).body.project.values.check).toBe("make check");
		expect(w.state.daemonEvents().map((e) => e.data.check)).toEqual(["", "npm test", "make check"]);
	});

	test("gitignore: .capcomd/ appended once (created when missing), skipped when git already ignores it", async () => {
		const w = world();
		const a = github();
		const r = await w.setup({ path: a, gitignore: true });
		expect(r.status).toBe(200);
		expect(read(join(a, ".gitignore"))).toBe(".capcomd/\n");
		expect(w.state.daemonEvents()[0]!.data).toMatchObject({ gitignored: true });
		const again = await w.setup({ path: a, gitignore: true });
		expect(again.body.changed).toBe(false);
		expect(read(join(a, ".gitignore"))).toBe(".capcomd/\n");
		// An existing .gitignore without a final newline.
		const b = github({ ".gitignore": "node_modules/" });
		await w.setup({ path: b, gitignore: true });
		expect(read(join(b, ".gitignore"))).toBe("node_modules/\n.capcomd/\n");
		// Ignored already (another pattern): untouched.
		const c = github({ ".gitignore": ".capcomd\n" });
		await w.setup({ path: c, gitignore: true });
		expect(read(join(c, ".gitignore"))).toBe(".capcomd\n");
		// Not asked: untouched.
		const d = github();
		await w.setup({ path: d });
		expect(existsSync(join(d, ".gitignore"))).toBe(false);
	});

	test("a .gitignore that is a symlink out of the checkout: refused, nothing written", async () => {
		const w = world();
		const a = github();
		const outside = join(mkdtempSync(join(dir, "out-")), "ignore");
		writeFileSync(outside, "x\n");
		symlinkSync(outside, join(a, ".gitignore"));
		const r = await w.setup({ path: a, gitignore: true });
		expect(r).toMatchObject({ status: 422, body: { code: "invalid", field: "path", message: expect.stringContaining("leads outside the checkout") } });
		expect(read(outside)).toBe("x\n");
		expect(existsSync(join(a, ".capcomd"))).toBe(false);
	});
});
