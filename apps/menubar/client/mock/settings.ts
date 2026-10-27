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
type Place = "docker" | "boxd";
type Provider = "claude" | "codex";
export type SettingsScene = {
  name: string;
  logins: { provider: Provider; sandbox: Place; loggedIn: boolean; how: "plan" | "api_key" | null; detail: string | null; command: string }[];
  environments: { sandbox: Place; status: "ready" | "missing" | "building" | "failed"; name: string | null; versions: Record<string, string>; builtAt: string | null; command: string }[];
  service: { installed: boolean; loaded: boolean; installCommand: string; uninstallCommand: string };
  boxdKey: boolean;
  dockerUp: boolean;
};

export const SETTINGS_CAPS = ["runs.options", "runs.options.repo", "runs.options.sandbox", "logins", "environments", "service"];
const PLACE_LABEL: Record<Place, string> = { docker: "Local", boxd: "Cloud" };
const DRIVER_LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };
const BUILT = "2026-10-24T09:12:03.000Z";
const VERSIONS = { claude: "2.1.303", codex: "0.163.0", node: "22.11.0" };

const login = (provider: Provider, sandbox: Place, how: "plan" | "api_key" | null) => ({
  provider, sandbox, loggedIn: how !== null, how,
  detail: how === "plan" ? `Logged in with a ${provider === "claude" ? "Claude" : "ChatGPT"} plan` : how === "api_key" ? "Using an API key" : null,
  command: `capcomd auth login ${provider} --sandbox ${sandbox}`,
});
const environment = (sandbox: Place, status: "ready" | "missing" | "building" | "failed") => ({
  sandbox, status, name: status === "ready" ? `capcomd-env-${sandbox}-3f2a91` : null, versions: status === "ready" ? VERSIONS : {},
  builtAt: status === "ready" ? BUILT : null, command: `capcomd env build --sandbox ${sandbox}`,
});
const service = (on: boolean) => ({ installed: on, loaded: on, installCommand: "capcomd service install", uninstallCommand: "capcomd service uninstall" });

export function settingsScene(name = process.env.SETTINGS ?? "mixed"): SettingsScene {
  const mixed = (local: "missing" | "building" | "failed"): SettingsScene => ({
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
export const settingsCaps = (s: SettingsScene) => s.name === "old" ? ["runs.options", "runs.options.repo"] : SETTINGS_CAPS;

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
  if (!["/v1/logins", "/v1/environments", "/v1/service"].includes(path)) return null;
  if (s.name === "old") return Response.json({ code: "not_found", message: "no such route" }, { status: 404 });
  if (path === "/v1/logins") return Response.json({ logins: s.logins });
  if (path === "/v1/environments") return Response.json({ environments: s.environments });
  return Response.json(s.service);
}
