// groundray's write path (ADR-025 §11.2, step 5; D9: the bundle for reads, the CLI for proposals): a proposal to a
// brain becomes a draft item on a proposal branch of the brain's repository and a pull request there, never a change to
// what agents read. The brain mapped and pinned for reads (src/context/groundray.ts) is untouched: the host's files
// mirror, the trees placed in sandboxes and the brain's own branch stay as they were. Each proposal runs in a throwaway
// directory of its own:
//
//   <dir>/brain.git   a bare host repo (src/merge/host-git.ts): the one place that talks to the brain's remote. It
//                     fetches the brain's branch and the proposal branch, and later pushes the proposal branch;
//   <dir>/authoring   the authoring clone groundray writes in: a host repo too, fetched from brain.git (a local path),
//                     on `main` at the proposal branch's tip (else the brain's branch's), as groundray requires;
//   <dir>/groundray   groundray's own config, data and cache (its catalog), so the user's groundray (its catalog, its
//                     installed brains, its skills) is never read or changed. HOME and XDG_* point here too.
//
// groundray is asked through its CLI, plan first and then `--apply` (`knowledge create`, cli.md "Draft knowledge
// creation"): `setup --non-interactive`, `brain add <authoring>` (a local path: groundray keeps it as the brain's
// authoring repository) and `knowledge create` with the item's type, title, description, body, the actor, `--method
// agent-generated`, a `low` confidence and its basis, and one source naming the run. groundray validates the bundle,
// writes the draft, regenerates its indexes and log, and commits in the authoring clone; it never talks to a remote.
// capcomd then checks that commit (a descendant of the base that changes nothing outside the bundle), fetches it into
// brain.git and pushes it to the proposal branch with a lease (never over someone else's push), and the forge that serves
// the brain's remote opens (or finds) the pull request into the brain's branch. Promotion (`stable`, `verified`) stays a
// person's, in groundray's own flow: a draft never raises authority.
//
// The actor is the person who approved the proposal (`human:<id>`, from an operator's or driver's principal), else
// capcomd itself (`capcomd/<version>`): an agent can't name a person (ADR-025 §7). Idempotent by a marker in the item's
// source (`capcomd://runs/<run>/agents/<agent>/proposals/<key>`): a proposal the branch already holds is found, not
// made again, and its pull request is found too.
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { PluginError } from "../../packages/plugin/src/errors";
import type { SeamCall } from "../../packages/plugin/src/seams";
import type { Principal } from "../../packages/plugin/src/shapes";
import { VERSION } from "../utils/self";

/** The item types groundray's core profile has (its `KnowledgeType`): a brain proposal is one of them. */
export const GROUNDRAY_TYPES = ["concept", "decision", "procedure", "policy", "system", "source-summary", "question"] as const;
export type GroundrayType = typeof GROUNDRAY_TYPES[number];
export const isGroundrayType = (t: unknown): t is GroundrayType => typeof t === "string" && (GROUNDRAY_TYPES as readonly string[]).includes(t);

/** A brain's name, as a profile and the project's mapping write it. */
export const BRAIN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** groundray bounds a body to 1 MiB. */
const BODY_MAX_BYTES = 1024 * 1024;
/** How long one groundray command may take (its plan validates the whole bundle). */
const CLI_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 120_000;

/** The groundray CLI on this machine: CAPCOMD_GROUNDRAY (a path), else `groundray` on PATH; null when there is none. */
export function groundrayBin(env: Record<string, string | undefined> = process.env): string | null {
  const named = env.CAPCOMD_GROUNDRAY?.trim();
  if (named) return existsSync(named) ? named : null;
  return Bun.which("groundray", { PATH: env.PATH ?? "" }) ?? null;
}

/**
 * Who a proposal is groundray's `--actor` as (ADR-025 §7, groundray's `human:id, process:id, or producer/version`): the
 * person whose principal sent it (an operator's or a driver's: `human:<their client id>`, `human:operator` for the local
 * CLI's), else capcomd itself. An agent or a plugin never names a person.
 */
export function actorOf(by: Principal): string {
  if (by.kind === "operator" || by.kind === "driver") return `human:${by.clientId && /^[A-Za-z0-9._-]{1,64}$/.test(by.clientId) ? by.clientId : by.kind}`;
  return `capcomd/${VERSION}`;
}

/** One brain, as the write path needs it: its repository and branch, and its identity (groundray's brain.yaml). */
export interface BrainTarget { name: string; repo: string; branch: string; slug: string; id: string; bundle: string }

/** What a proposal asks groundray to create. */
export interface BrainDraft {
  type: GroundrayType;
  title: string;
  /** The item's body: Markdown without frontmatter, as the agent said it. */
  body: string;
  /** Who proposed it, from the kernel's records: the branch and the source are named by them. */
  origin: { runId: string; agentId: string };
}

export interface BrainWritten {
  /** The item's id (groundray's `urn:uuid:…`), its path in the repository and the commit that added it. */
  itemId: string;
  path: string;
  commit: string;
  branch: string;
  /** The pull request on the brain's repository, or null when no forge there opens one (the branch is pushed). */
  pullRequest: { number: number; url: string | null } | null;
  /** The branch held it already (a replay): nothing was created. */
  already: boolean;
}

/** The branch a run's agent's proposals go on, in groundray's namespace for proposals (`refs/heads/groundray/`). */
export const proposalBranch = (o: { runId: string; agentId: string }) => `groundray/capcomd-${o.runId}-${o.agentId}`.replace(/[^A-Za-z0-9._/-]/g, "-");

/** The proposal's own key: the same proposal from the same agent is the same key, whoever sends it and when. */
export const proposalKey = (d: Pick<BrainDraft, "type" | "title" | "body" | "origin">) =>
  createHash("sha256").update([d.origin.runId, d.origin.agentId, d.type, d.title, d.body].join("\0")).digest("hex").slice(0, 16);

/** The source each draft carries: where it was proposed, and the marker that finds it on the branch again. */
export const proposalSource = (d: BrainDraft) => ({
  id: "capcomd-proposal",
  resource: `capcomd://runs/${d.origin.runId}/agents/${d.origin.agentId}/proposals/${proposalKey(d)}`,
  title: `Proposed by capcomd agent ${d.origin.agentId} in run ${d.origin.runId}`,
});

/** The description groundray asks for: the body's first sentence, one line, at most 200 characters. */
export function descriptionOf(body: string, title: string): string {
  const text = body.replace(/^#+\s.*$/gm, " ").replace(/\s+/g, " ").trim();
  const first = (/^(.{1,200}?[.!?])(\s|$)/.exec(text)?.[1] ?? text.slice(0, 200)).trim();
  return first || title;
}

const slugOf = (title: string) => title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
/** groundray's strict UTC RFC 3339 time, to the second. */
const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Why groundray can't take a proposal ("it …"), or null. */
export function draftProblem(d: { type: unknown; title: string; body: string }): string | null {
  if (!isGroundrayType(d.type)) return `has no type groundray knows (${GROUNDRAY_TYPES.join(", ")})`;
  if (!d.title.trim() || d.title.length > 200 || /[\r\n]/.test(d.title)) return "has no one-line title";
  if (!d.body.trim()) return "has no text";
  if (Buffer.byteLength(d.body) > BODY_MAX_BYTES) return "is over groundray's 1 MiB for a body";
  if (/^\uFEFF?---[ \t]*\r?\n/.test(d.body)) return "starts with YAML frontmatter, which groundray writes itself";
  return null;
}

interface Run { code: number; stdout: string; stderr: string }

/** What the write path runs (tests swap in a fake CLI through CAPCOMD_GROUNDRAY; this is for its plumbing). */
export interface WriteDeps {
  bin: string;
  /** Where the throwaway directories go (one per proposal, removed after). */
  workdir: string;
  /** Opens or finds the pull request (the forge serving `remote`), or null when none opens one there. */
  pullRequest: (input: { remote: string; head: string; base: string; title: string; body: string }, c: SeamCall) => Promise<{ number: number; url: string | null } | null>;
  now?: () => Date;
}

/** groundray, in the throwaway's own environment: nothing of the user's home, nothing of capcomd's secrets. */
async function groundray(bin: string, home: string, args: string[], c: SeamCall): Promise<Run> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(home, "home"), TMPDIR: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    LANG: process.env.LANG || "C.UTF-8", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "capcomd", GIT_AUTHOR_EMAIL: "capcomd@users.noreply.github.com", GIT_COMMITTER_NAME: "capcomd", GIT_COMMITTER_EMAIL: "capcomd@users.noreply.github.com",
  };
  const p = Bun.spawn([bin, ...args, "--config", join(home, "config", "groundray", "config.yaml")], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => { try { p.kill("SIGKILL"); } catch { /* gone */ } };
  const t = setTimeout(kill, Math.max(1, Math.min(CLI_TIMEOUT_MS, Date.parse(c.deadline) - Date.now())));
  c.signal.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } finally { clearTimeout(t); c.signal.removeEventListener("abort", kill); }
}

/** groundray's `--json` answer, or a PluginError naming the command and what it said. */
function answer(r: Run, what: string): Record<string, unknown> {
  const said = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ").slice(0, 400);
  if (r.code !== 0) throw new PluginError(r.code === 2 ? "invalid" : "unavailable", `groundray ${what} failed (${r.code}): ${said || "no output"}`);
  try {
    const v = JSON.parse(r.stdout) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* below */ }
  throw new PluginError("unavailable", `groundray ${what} didn't answer JSON: ${r.stdout.trim().slice(0, 200) || "nothing"}`);
}

/**
 * Propose `draft` to `brain` as `actor` (the module's header says how). Rejects with a PluginError: `unavailable` (the
 * brain or groundray couldn't be reached or refused), `invalid` (a proposal groundray can't take, or a commit that
 * changes files outside the bundle), `conflict` (the proposal branch moved twice while this pushed).
 */
export async function writeToBrain(brain: BrainTarget, draft: BrainDraft, actor: string, deps: WriteDeps, c: SeamCall): Promise<BrainWritten> {
  const problem = draftProblem(draft);
  if (problem) throw new PluginError("invalid", `brain ${brain.name} can't take this proposal: it ${problem}`);
  const { initHostRepo, remoteGit } = await import("../merge/host-git");
  const branch = proposalBranch(draft.origin);
  const source = proposalSource(draft);
  mkdirSync(deps.workdir, { recursive: true });
  // A real path (macOS's /var is a link): groundray refuses an authoring path with a link in it.
  const dir = realpathSync(mkdtempSync(join(deps.workdir, "brain-proposal-")));
  try {
    for (let attempt = 1; ; attempt++) {
      const r = await once(attempt);
      if (r) return r;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  async function once(attempt: number): Promise<BrainWritten | null> {
    const net = { timeoutMs: GIT_TIMEOUT_MS, signal: c.signal };
    const fail = (what: string, r: { code: number; stderr: string; stdout: string }, code: "unavailable" | "conflict" = "unavailable") =>
      new PluginError(code, `${what} (${r.code}): ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    // The brain's branch and the proposal branch, as the remote has them now.
    const bare = join(dir, `brain-${attempt}.git`);
    const host = await initHostRepo(bare, { bare: true });
    const heads = await remoteGit(host, ["ls-remote", "--heads", brain.repo, brain.branch, branch], brain.repo, net);
    if (heads.code !== 0) throw fail(`can't read brain ${brain.name} at ${brain.repo}`, heads);
    const tipOf = (b: string) => new RegExp(`^([0-9a-f]{40,64})\\trefs/heads/${b.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m").exec(heads.stdout)?.[1] ?? null;
    const brainTip = tipOf(brain.branch), proposed = tipOf(branch);
    if (!brainTip) throw new PluginError("unavailable", `brain ${brain.name} has no branch ${brain.branch} at ${brain.repo}`);
    const refs = [`+refs/heads/${brain.branch}:refs/remotes/brain/${brain.branch}`, ...(proposed ? [`+refs/heads/${branch}:refs/remotes/brain/${branch}`] : [])];
    const fetched = await remoteGit(host, ["fetch", "-q", "--no-tags", brain.repo, ...refs], brain.repo, net);
    if (fetched.code !== 0) throw fail(`can't fetch brain ${brain.name} from ${brain.repo}`, fetched);
    const base = proposed ?? brainTip;

    // Already there (a replay, or the same proposal sent twice): the item that carries this proposal's marker.
    if (proposed) {
      const found = await host.run(["grep", "-l", "-F", source.resource, proposed, "--", `${brain.bundle}/`]);
      const path = found.code === 0 ? found.stdout.split("\n")[0]!.replace(/^[0-9a-f]+:/, "") : null;
      if (path) {
        const text = (await host.run(["show", `${proposed}:${path}`])).stdout;
        const itemId = /^id:\s*["']?([^"'\s]+)["']?\s*$/m.exec(text)?.[1] ?? "";
        const commit = (await host.run(["log", "-1", "--format=%H", proposed, "--", path])).stdout.trim() || proposed;
        return { itemId, path, commit, branch, pullRequest: await pr(), already: true };
      }
    }

    // The authoring clone: on main at the base, as groundray wants it, its origin the bare repo (a local path).
    await host.ok(["update-ref", "refs/heads/main", base]);
    await host.ok(["symbolic-ref", "HEAD", "refs/heads/main"]);
    const authoring = join(dir, `authoring-${attempt}`);
    const a = await initHostRepo(authoring);
    await a.ok(["remote", "add", "origin", bare]);
    const local = await remoteGit(a, ["fetch", "-q", "--no-tags", bare, "+refs/heads/main:refs/remotes/origin/main"], bare, net);
    if (local.code !== 0) throw fail("can't make the authoring clone", local);
    await a.ok(["checkout", "-q", "-B", "main", base]);

    // groundray, in its own throwaway settings: set up, the brain added from the authoring clone, the draft planned, then
    // applied. Nothing it does reaches a remote.
    const home = join(dir, `groundray-${attempt}`);
    for (const d of ["home", "tmp", "config", "data", "cache"]) mkdirSync(join(home, d), { recursive: true });
    answerOrOk(await groundray(deps.bin, home, ["setup", "--non-interactive", "--search-mode", "keyword", "--data-dir", join(home, "data", "groundray"), "--cache-dir", join(home, "cache", "groundray")], c), "setup");
    const added = answer(await groundray(deps.bin, home, ["brain", "add", authoring, "--json"], c), "brain add");
    if ((typeof added.slug === "string" && added.slug !== brain.slug) || (typeof added.id === "string" && added.id !== brain.id)) throw new PluginError("invalid", `the repository mapped as brain ${brain.name} is another brain at its tip (${String(added.slug).slice(0, 63)})`, `Map it again: capcomd context brain add ${brain.name} ${brain.repo}`);
    const bodyFile = join(home, "tmp", "body.md"), sourcesFile = join(home, "tmp", "sources.json");
    writeFileSync(bodyFile, draft.body.endsWith("\n") ? draft.body : `${draft.body}\n`);
    writeFileSync(sourcesFile, JSON.stringify([source]));
    const now = deps.now?.() ?? new Date();
    // Every value as `--option=value`, one argument: a title the agent wrote that starts with `-` stays a title.
    const create = ["knowledge", "create", ...Object.entries({
      brain: brain.slug, type: draft.type, title: draft.title.trim(), description: descriptionOf(draft.body, draft.title),
      actor, method: "agent-generated", "body-file": bodyFile, "sources-file": sourcesFile,
      path: `inbox/${slugOf(draft.title)}-${proposalKey(draft).slice(0, 6)}.md`, confidence: "low",
      "confidence-basis": `Proposed by agent ${draft.origin.agentId} of capcomd run ${draft.origin.runId}${actor.startsWith("human:") ? `, sent by ${actor}` : ""}; no one has verified it yet.`,
      timestamp: utc(now),
    }).map(([k, v]) => `--${k}=${v}`), "--json"];
    answer(await groundray(deps.bin, home, create, c), "knowledge create (plan)");
    const saved = answer(await groundray(deps.bin, home, [...create, "--apply"], c), "knowledge create --apply");
    const itemId = typeof saved.item_id === "string" ? saved.item_id : "";
    const head = (await a.ok(["rev-parse", "HEAD"])).trim();

    // What groundray committed: on the base, inside the bundle only. Anything else is never pushed.
    if (head === base) throw new PluginError("unavailable", "groundray saved nothing in the authoring clone");
    if ((await a.run(["merge-base", "--is-ancestor", base, head])).code !== 0) throw new PluginError("invalid", "groundray's commit isn't on the brain's branch");
    const changed = (await a.ok(["-c", "core.quotepath=off", "diff", "--name-only", "-z", base, head])).split("\0").filter(Boolean);
    const outside = changed.filter((p) => !p.startsWith(`${brain.bundle}/`));
    if (outside.length) throw new PluginError("invalid", `groundray's commit changes files outside the brain's bundle (${outside.slice(0, 3).join(", ")}): capcomd doesn't push it`);
    const path = typeof saved.path === "string" && saved.path ? (saved.path.startsWith(`${brain.bundle}/`) ? saved.path : `${brain.bundle}/${saved.path}`) : changed.find((p) => p.includes("/inbox/")) ?? "";

    // Into the bare repo, then pushed with a lease: never over a proposal branch someone else moved meanwhile.
    const back = await remoteGit(host, ["fetch", "-q", "--no-tags", authoring, "+refs/heads/main:refs/capcomd/authored"], authoring, net);
    if (back.code !== 0) throw fail("can't read groundray's commit back", back);
    const pushed = await remoteGit(host, ["push", "-q", `--force-with-lease=refs/heads/${branch}:${proposed ?? ""}`, brain.repo, `${head}:refs/heads/${branch}`], brain.repo, net);
    if (pushed.code !== 0) {
      if (attempt < 2 && /stale info|rejected|fetch first|non-fast-forward/i.test(pushed.stderr + pushed.stdout)) return null;
      throw fail(`can't push ${branch} to ${brain.repo}`, pushed, attempt < 2 ? "unavailable" : "conflict");
    }
    return { itemId, path, commit: head, branch, pullRequest: await pr(), already: false };
  }

  /** The pull request into the brain's branch: found, else opened. */
  async function pr() {
    return deps.pullRequest({
      remote: brain.repo, head: branch, base: brain.branch,
      title: `Proposed knowledge from capcomd run ${draft.origin.runId}`,
      body: [
        `Draft knowledge proposed by agent ${draft.origin.agentId} of capcomd run ${draft.origin.runId}, sent by ${actor}.`,
        "",
        "Each commit adds one draft item (status: draft, generated by groundray's `knowledge create` with method agent-generated, low confidence). Review the items here; promoting one (verifying it, making it stable) is a person's step in groundray's own flow.",
        "",
        `Its source names where it was proposed (capcomd://runs/${draft.origin.runId}/agents/${draft.origin.agentId}/…).`,
      ].join("\n"),
    }, c);
  }
}

/** setup answers no JSON: only its exit code says. */
function answerOrOk(r: Run, what: string): void {
  if (r.code !== 0) answer(r, what);
}
