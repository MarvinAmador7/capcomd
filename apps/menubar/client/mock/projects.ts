// Project setup for the mocks (server.ts, scenarios.ts): GET /v1/projects/inspect and POST /v1/projects (capability
// projects.setup), answered as the daemon does (src/api/projects.ts), with its sentences. GET /v1/run-options?repo= for a
// folder that isn't set up yet is 422 like the daemon's; once a POST set it up, it answers as usual.
//
//   PROJECTS=<scene>: what any folder looks like (a folder named like a scene, e.g. /tmp/x/notgit, answers as that scene)
//                     ready       a GitHub checkout (acme/app), not set up yet: gh logged in, Claude Code with a plan
//                     configured  already set up (direct merges into capcomd/staging, both agents, `bun run test`)
//                     notgit      not a git checkout
//                     notgithub   a checkout whose origin is on GitLab: for `capcomd setup project` in Terminal
//                     nogh        a GitHub checkout, but gh isn't logged in: pull requests unavailable, direct suggested
//                     apikey      a GitHub checkout; Claude Code has only an API key, so a spend cap is asked
//                     refuse      as ready, but every POST is 422 (the checkout's .capcomd is a symlink out of it)
//                     old         a daemon from before projects.setup: no capability, both routes 404
//   A folder ending in /src is inside the checkout: `root` is its parent. SCOPES=read,steer,approve (no configure): a
//   POST is 403. Set-up folders last for the server's life; the same Idempotency-Key answers the same again.
type Scene = "ready" | "configured" | "notgit" | "notgithub" | "nogh" | "apikey" | "refuse" | "old";
const SCENES: Scene[] = ["ready", "configured", "notgit", "notgithub", "nogh", "apikey", "refuse", "old"];
export type ProjectsScene = {
  scene: Scene;
  scopes: string[];
  /** Folders set up by a POST (root → values). */
  setUp: Map<string, any>;
  answers: Map<string, { request: string; status: number; body: unknown }>;
};

export function projectsScene(name = process.env.PROJECTS ?? "ready"): ProjectsScene {
  if (!SCENES.includes(name as Scene)) throw new Error(`unknown PROJECTS ${name}; one of ${SCENES.join(", ")}`);
  const scopes = process.env.SCOPES?.split(",").map((x) => x.trim()).filter(Boolean) ?? ["read", "steer", "approve", "configure"];
  return { scene: name as Scene, scopes, setUp: new Map(), answers: new Map() };
}
export const projectsCaps = (s: ProjectsScene) => (s.scene === "old" ? [] : ["projects.setup"]);

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, code: string, message: string, extra: object = {}) => json({ code, message, ...extra }, status);
const sceneOf = (path: string, s: ProjectsScene): Scene => {
  const base = path.replace(/\/src$/, "").split("/").pop() ?? "";
  return (SCENES as string[]).includes(base) && base !== "old" ? (base as Scene) : s.scene;
};
const rootOf = (path: string) => path.replace(/\/src$/, "");
const nameOf = (root: string) => (root.split("/").pop() || "project").replace(/[^A-Za-z0-9._-]+/g, "-");
const place = (sandbox: string, how: "plan" | "api_key" | null) => ({ sandbox, loggedIn: how !== null, how });
const CONFIGURED = { repo: "https://github.com/acme/app.git", mode: "direct", target: "capcomd/staging", check: "bun run test", agents: ["claude", "codex"], budgetUsd: null };

/** GET /v1/projects/inspect?path= as the daemon answers it. */
export function inspect(path: string, s: ProjectsScene) {
  const scene = sceneOf(path, s), root = rootOf(path), apikey = scene === "apikey";
  const agents = [
    { provider: "claude", label: "Claude Code", loggedIn: true, auth: apikey ? "apikey" : "subscription",
      places: [place("docker", apikey ? "api_key" : null), place("boxd", apikey ? null : "plan")] },
    { provider: "codex", label: "Codex", loggedIn: false, auth: "subscription", places: [place("docker", null), place("boxd", null)] },
  ];
  const base = { path, root: null as string | null, name: null as string | null, configured: false, values: null as any, repo: null as string | null, github: null as string | null,
    ghReady: false, defaultBranch: "main", branches: [] as string[], suggestedCheck: "", suggestedMode: "direct", suggestedAgents: ["claude"], agents, budgetAsked: apikey,
    problems: [] as { code: string; message: string }[] };
  if (scene === "notgit") return { ...base, problems: [{ code: "not_git", message: `${path} isn't a git checkout. Choose your repository's folder, or clone it first.` }] };
  const gitlab = scene === "notgithub";
  const repo = gitlab ? "https://gitlab.com/acme/app.git" : "https://github.com/acme/app.git";
  const ghReady = !gitlab && scene !== "nogh";
  const values = s.setUp.get(root) ?? (scene === "configured" ? CONFIGURED : null);
  return {
    ...base, root, name: nameOf(root), configured: values !== null, values, repo, github: gitlab ? null : "acme/app", ghReady,
    branches: ["capcomd/staging", "main"], suggestedCheck: "bun run test", suggestedMode: ghReady ? "pr" : "direct",
    problems: gitlab ? [{ code: "not_github", message: `${root}'s origin (${repo}) isn't on GitHub. The app sets up GitHub checkouts; set this one up with \`capcomd setup project\` in Terminal.` }] : [],
  };
}

/** POST /v1/projects as the daemon answers it (the checks of src/api/projects.ts setUpProject). */
async function setUp(s: ProjectsScene, req: Request): Promise<Response> {
  if (!s.scopes.includes("configure")) return fail(403, "forbidden", "token lacks the configure scope");
  const key = req.headers.get("idempotency-key");
  if (!key || key.length < 8 || key.length > 200) return fail(422, "invalid", "Idempotency-Key header (8-200 chars) is required");
  const b: any = await req.json().catch(() => null);
  if (!b || typeof b.path !== "string" || !b.path.startsWith("/")) return fail(422, "invalid", "path: path must be an absolute path", { field: "path" });
  const request = JSON.stringify([b.path, b.mode, b.target, b.check, b.agents, b.budgetUsd ?? null, b.expect?.repo ?? null]);
  const prior = s.answers.get(key);
  if (prior) return prior.request === request ? json(prior.body, prior.status) : fail(409, "idempotency_conflict", "Idempotency-Key reused with a different request");
  const i = inspect(b.path, s), scene = sceneOf(b.path, s);
  const no = (message: string, field: string, extra: object = {}) => fail(422, "invalid", message, { field, ...extra });
  if (i.problems[0]) return no(i.problems[0].message, "path", { problem: i.problems[0].code });
  if (b.mode !== "pr" && b.mode !== "direct") return no("mode: Invalid option: expected one of \"pr\"|\"direct\"", "mode");
  if (b.expect && b.expect.repo !== i.repo) return fail(409, "conflict", `${i.root}'s origin changed since you looked: it's ${i.repo} now. Look at the folder again before setting it up.`, { repo: i.repo });
  if (b.mode === "pr" && !i.ghReady) return no("Pull requests need the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), so choose direct merges or log in first.", "mode");
  if (typeof b.target !== "string" || !/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*[./]$)[A-Za-z0-9._/-]{1,200}$/.test(b.target)) return no(`"${String(b.target).slice(0, 80)}" isn't a branch name capcomd can merge into (letters, digits, ".", "_", "-" and "/").`, "target");
  if (typeof b.check !== "string" || /[\n\r]/.test(b.check)) return no("check: check is one line", "check");
  const agents = ["claude", "codex"].filter((a) => Array.isArray(b.agents) && b.agents.includes(a));
  if (!agents.length || agents.length !== b.agents.length) return no("Choose Claude Code, Codex or both, once each.", "agents");
  const asked = i.agents.some((a) => agents.includes(a.provider) && a.auth === "apikey");
  if (b.budgetUsd !== undefined && !asked) return no("None of these agents bills an API key, so there's no spend to cap: leave the budget out.", "budgetUsd");
  if (b.budgetUsd !== undefined && !(typeof b.budgetUsd === "number" && b.budgetUsd > 0)) return no("The spend cap is an amount in USD over 0, or none for no limit.", "budgetUsd");
  if (scene === "refuse") return no(`${i.root}/.capcomd leads outside the checkout (a symlink), so capcomd won't write there. Remove the link, or set the project up with \`capcomd setup project\` in Terminal.`, "path");
  const values = { repo: i.repo, mode: b.mode, target: b.target, check: b.check || (i.values?.check ?? ""), agents, budgetUsd: b.budgetUsd ?? null };
  const changed = JSON.stringify(s.setUp.get(i.root!) ?? i.values) !== JSON.stringify(values);
  s.setUp.set(i.root!, values);
  const body = { project: { path: b.path, root: i.root, name: i.name, configured: true, values }, changed };
  s.answers.set(key, { request, status: 200, body });
  return json(body);
}

/** The project routes, or null for any other path. */
export function projectsRoute(url: URL, s: ProjectsScene, req: Request): Response | Promise<Response> | null {
  const p = url.pathname;
  if (p === "/v1/projects/inspect" && req.method === "GET") {
    if (s.scene === "old") return fail(404, "not_found", "GET /v1/projects/inspect");
    const path = url.searchParams.get("path") ?? "";
    if (!path.startsWith("/")) return fail(422, "invalid", "path: path must be an absolute path");
    return json(inspect(path, s));
  }
  if (p === "/v1/projects" && req.method === "POST") return s.scene === "old" ? fail(404, "not_found", "POST /v1/projects") : setUp(s, req);
  return null;
}

/** GET /v1/run-options?repo= for a folder that isn't set up: the daemon's 422. null: answer as usual. */
export function projectsRunOptionsRefusal(url: URL, s: ProjectsScene): Response | null {
  const repo = url.searchParams.get("repo");
  if (url.pathname !== "/v1/run-options" || !repo) return null;
  const i = inspect(repo, s);
  if (i.configured) return null;
  return fail(422, "invalid", `${repo} is not a capcomd project (no .capcomd/config.json in it or above it). Run \`capcomd setup project\` in it first.`);
}
