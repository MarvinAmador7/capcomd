// A stand-in for the groundray CLI (github.com/MarvinAmador7/groundray, docs/cli.md), for the write path's tests
// (ADR-025 step 5): never the real one. It does what capcomd asks of groundray, as its documentation says groundray does
// it, and records each call: `setup --non-interactive` writes the config `--config` names; `brain add <local path>`
// installs a brain from a clone, keeping that clone as its authoring repository; `knowledge create` plans a draft (JSON,
// no files changed) and, with `--apply`, writes it under the bundle, appends to its log and commits in the authoring
// repository (on main, clean, at the installed commit). Knobs (environment, set by a test's wrapper):
//   FAKE_GROUNDRAY_LOG       a file each call appends a JSON line to: {argv, home, xdg}
//   FAKE_GROUNDRAY_OUTSIDE   `--apply` also writes NOTES.md at the repository's root (outside the bundle)
//   FAKE_GROUNDRAY_FAIL      a command (`setup`, `brain`, `knowledge`) that fails with exit 1
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(name);
const out = (v: unknown) => { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`); process.exit(0); };
const die = (code: number, msg: string): never => { process.stderr.write(`${msg}\n`); process.exit(code); };
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) die(1, `git ${args[0]} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

if (process.env.FAKE_GROUNDRAY_LOG) appendFileSync(process.env.FAKE_GROUNDRAY_LOG, `${JSON.stringify({ argv, home: process.env.HOME, xdg: process.env.XDG_DATA_HOME })}\n`);
if (process.env.FAKE_GROUNDRAY_FAIL && argv[0] === process.env.FAKE_GROUNDRAY_FAIL) die(1, "the fake groundray was told to fail");

const config = opt("--config") ?? die(2, "the fake groundray needs --config");
interface Settings { data_dir: string; cache_dir: string }
interface Catalog { brains: Record<string, { id: string; source: string; authoring: string; commit: string }> }
const settings = (): Settings => existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : die(1, "No configuration: run groundray setup");
const catalogPath = () => join(settings().data_dir, "catalog.json");
const catalog = (): Catalog => existsSync(catalogPath()) ? JSON.parse(readFileSync(catalogPath(), "utf8")) : { brains: {} };

if (argv[0] === "setup") {
  if (!has("--non-interactive")) die(2, "Interactive setup requires a terminal. Use --non-interactive.");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ data_dir: opt("--data-dir"), cache_dir: opt("--cache-dir") }));
  process.exit(0);
}

if (argv[0] === "brain" && argv[1] === "add") {
  const source = argv[2] ?? die(2, "brain add needs a source");
  if (/^[a-z]+:\/\//.test(source)) die(1, "the fake groundray only adds local paths");
  const dir = realpathSync(source);
  if (dir.startsWith(realpathSync(dirname(settings().data_dir)))) die(1, "Authoring repository must be outside managed brain storage.");
  const yaml = readFileSync(join(dir, "brain.yaml"), "utf8");
  const slug = /^slug:\s*(\S+)/m.exec(yaml)?.[1] ?? die(1, "no slug"), id = /^id:\s*(\S+)/m.exec(yaml)?.[1] ?? die(1, "no id");
  if (git(dir, "branch", "--show-current") !== "main") die(1, "Authoring repository must be on main.");
  const commit = git(dir, "rev-parse", "HEAD");
  mkdirSync(settings().data_dir, { recursive: true });
  const c = catalog();
  c.brains[slug] = { id, source: dir, authoring: dir, commit };
  writeFileSync(catalogPath(), JSON.stringify(c));
  out({ slug, id, name: `${slug} fictional`, commit, active: true, validation_warnings: [] });
}

if (argv[0] === "knowledge" && argv[1] === "create") {
  for (const f of ["--type", "--title", "--description", "--actor", "--body-file"]) if (!opt(f)) die(2, "Provide all of --type, --title, --description, --actor, and --body-file, or omit all five to use interactive authoring.");
  const slug = opt("--brain") ?? die(1, "no active brain");
  const b = catalog().brains[slug] ?? die(1, `Brain is not installed: ${slug}`);
  const repo = b.authoring;
  if (git(repo, "status", "--porcelain")) die(1, "Authoring repository has uncommitted changes.");
  if (git(repo, "rev-parse", "HEAD") !== b.commit) die(1, "Authoring HEAD differs from the installed commit.");
  const body = readFileSync(opt("--body-file")!, "utf8");
  if (body.startsWith("---")) die(1, "Body must not include YAML frontmatter.");
  const sources = opt("--sources-file") ? JSON.parse(readFileSync(opt("--sources-file")!, "utf8")) : [];
  const rel = opt("--path") ?? `inbox/${opt("--title")!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  const file = join(repo, "knowledge", rel);
  if (existsSync(file)) die(1, `Destination exists: ${rel}`);
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const meta = {
    id, type: opt("--type"), title: opt("--title"), description: opt("--description"), status: "draft",
    generated: { by: opt("--actor"), at: opt("--timestamp") ?? new Date().toISOString(), method: opt("--method") ?? "human-authored" },
    sources, ...(opt("--confidence") ? { confidence: { level: opt("--confidence"), basis: opt("--confidence-basis") ?? "" } } : {}),
  };
  const text = `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${body}`;
  if (!has("--apply")) out({ proposed_item: { ...meta, body, path: rel }, changes: [{ path: `knowledge/${rel}`, diff: `+++ knowledge/${rel}\n` }] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  appendFileSync(join(repo, "knowledge", "log.md"), `\n- ${meta.generated.at} created ${rel} (${id})\n`);
  if (process.env.FAKE_GROUNDRAY_OUTSIDE) writeFileSync(join(repo, "NOTES.md"), "outside the bundle\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Groundray", "-c", "user.email=groundray@localhost.invalid", "commit", "-q", "-m", `Create draft ${rel}`);
  const commit = git(repo, "rev-parse", "HEAD");
  const c = catalog();
  c.brains[slug]!.commit = commit;
  writeFileSync(catalogPath(), JSON.stringify(c));
  out({ item_id: id, path: rel, saved_version: commit, retrieval_ready: true, search_ready: false, needs_reindex: true, citation: { brain_slug: slug, commit, item_id: id, path: rel } });
}

die(2, `the fake groundray doesn't know: ${argv.join(" ")}`);
