// The Team screen's routes (apps/menubar/design/desktop/team), for running the app and its tests on the mock: the
// profiles of two projects and the user's own, as the daemon serves them. PROFILES=<scene>:
//   team   every route: GET /v1/profiles[?repo=], GET/PUT /v1/profiles/{name}, GET …/work, GET/PUT …/persona, avatarSeed
//          on the rows, and POST /v1/runs `planner` advertised (capabilities profiles, profiles.edit, profiles.work,
//          profiles.persona, profiles.avatar, runs.planner, projects.known, runs.options, runs.options.models)
//   basic  a daemon with the list and the rows only (profiles, profiles.edit): no recent work, no persona, no bot seed,
//          no planner runs; the app leaves those parts out
//   conflict  as team, but the first PUT finds the file changed by hand: 409 with the new rev (the app reads it again)
// PUT checks the rev (409 conflict with the current one) and writes into the scene's state for the server's life.
// The bench and the Swift tests have the same roster in Swift (app/Sources/DeskBenchKit/TeamFixture.swift).

export type ProfilesScene = { name: string; caps: string[]; avatars: boolean; conflictOnce: boolean };

const ALL = ["profiles", "profiles.edit", "profiles.facts", "profiles.work", "profiles.persona", "profiles.avatar", "runs.planner", "projects.known",
  "runs.options", "runs.options.models"];

export function profilesScene(name: string): ProfilesScene {
  switch (name) {
    case "team": return { name, caps: ALL, avatars: true, conflictOnce: false };
    case "basic": return { name, caps: ["profiles", "profiles.edit", "profiles.facts", "projects.known", "runs.options", "runs.options.models"], avatars: false, conflictOnce: false };
    case "conflict": return { name, caps: ALL, avatars: true, conflictOnce: true };
    default: throw new Error(`PROFILES=${name}: not a scene (team, basic, conflict)`);
  }
}
export const profilesCaps = (s: ProfilesScene) => s.caps;

const PROJECTS = [{ name: "capcomd", path: "/Users/dev/capcomd", default: true }, { name: "capcomd-site", path: "/Users/dev/capcomd-site", default: false }];
const err = (status: number, code: string, message: string, extra: object = {}) => Response.json({ code, message, ...extra }, { status });

type Row = Record<string, any>;
function row(s: ProfilesScene, name: string, source: string, o: Partial<{ title: string; tags: string[]; model: string | null; effort: string | null; mode: string;
  lead: string | null; fit: string; skills: string[]; version: number; extends: string; repo: string; provider: string }> = {}): Row {
  const dir = o.repo ? `${o.repo}/.capcomd/profiles` : "/Users/dev/.capcomd/profiles";
  const applied = [...(o.extends ? [{ as: "extends", name: o.extends, layer: "bundled", path: null }] : []), { as: "profile", name, layer: source, path: `${dir}/${name}.yaml` }];
  const fit = o.fit ?? "edits and runs code";
  return {
    name, version: o.version ?? 1, source, format: "v2", path: source === "bundled" ? null : `${dir}/${name}.yaml`, default: false, description: null, tags: o.tags ?? [],
    provider: o.provider ?? "claude", auth: "subscription", model: o.model === undefined ? "claude-opus-5-5" : o.model, effort: o.effort === undefined ? "high" : o.effort,
    toolMode: o.mode ?? "execute", canSpawn: !!o.lead || o.mode === "orchestrate", canLead: o.lead ?? null, does: fit, ready: true, readiness: "ready", applied,
    title: o.title ?? null, fit, cost: "high", canReport: true, skills: (o.skills ?? []).map((n) => ({ name: n, source, hash: `sha256:${n}`, trusted: true, changed: false })),
    untrustedSkills: [], untrustedPersona: null, untrustedSandbox: [], ...(s.avatars ? { avatarSeed: `${name}-seed` } : {}),
  };
}

function fields(r: Row) {
  const inherits = r.applied.some((a: any) => a.as === "extends");
  const f = (id: string, type: string, label: string, value: string | null, display: string, extra: object = {}) =>
    ({ id, type, label, help: null, value, display, choices: [], source: value === null ? "unset" : "profile", from: value === null ? null : r.applied.length - 1, editable: type !== "info", untrusted: false, ...extra });
  const out = [
    f("identity.title", "text", "Title", r.title, r.title ?? "Its name", { untrusted: true }),
    f("description", "text", "Description", null, "None", { untrusted: true }),
    f("tags", "list", "Tags", r.tags.length ? JSON.stringify(r.tags) : null, r.tags.length ? r.tags.join(", ") : "None"),
    f("harness.provider", "choice", "Agent", r.provider, r.provider === "codex" ? "Codex" : "Claude Code", { choices: [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }] }),
    f("harness.model", "text", "Model", r.model, r.model ?? "The agent's default"),
    f("harness.effort", "choice", "Effort", r.effort, r.effort ? r.effort[0].toUpperCase() + r.effort.slice(1) : "The agent's default",
      { choices: ["low", "medium", "high", "xhigh"].map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) })) }),
    f("sandbox.provider", "choice", "Runs on", "boxd", "Cloud · boxd", { source: "inherited", from: 0, choices: [{ value: "docker", label: "This Mac · Docker" }, { value: "boxd", label: "Cloud · boxd" }] }),
    f("tools.mode", "choice", "Works by", r.toolMode, r.toolMode === "orchestrate" ? "Orchestrating: sees everything, runs nothing" : "Executing: edits and runs code",
      { choices: [{ value: "execute", label: "Executing: edits and runs code" }, { value: "orchestrate", label: "Orchestrating: sees everything, runs nothing" }] }),
    f("permissions.report", "toggle", "May answer with a report", null, "Yes"),
    f("limits.maxTurns", "number", "Turns", "40", "40 turns", inherits ? { source: "inherited", from: 0 } : {}),
    f("limits.timeoutMs", "number", "Time limit", "1800000", "30 min"),
    f("limits.maxBudgetUsd", "number", "Budget", null, "No limit"),
    f("prompt.append", "info", "Added to the prompt", null, "Nothing"),
  ];
  if (r.name === "security-critic") out.push(f("sharing.source", "info", "sharing.source", "acme/capcomd-profiles", "acme/capcomd-profiles", { editable: false, untrusted: true }));
  return out;
}

type State = { scopes: Map<string, Row[]>; details: Map<string, { profile: Row; fields: any[]; rev: string; n: number }>; personas: Map<string, any>; conflicted: boolean };
const states = new Map<string, State>();
function state(s: ProfilesScene): State {
  let st = states.get(s.name);
  if (st) return st;
  const [a, b] = [PROJECTS[0].path, PROJECTS[1].path];
  const mine = [row(s, "security-critic", "user", { title: "Security critic", tags: ["review", "security"], fit: "read-only; answers with a report", skills: ["threat-model", "owasp-top-10"], version: 3, extends: "reviewer" }),
    row(s, "tern", "user", { model: "claude-sonnet-5-5", effort: "medium" })];
  const bundled = [row(s, "worker", "bundled"), row(s, "reviewer", "bundled", { fit: "read-only; answers with a report" })];
  const plans = { mode: "orchestrate", fit: "orchestrates: sees everything, runs nothing" };
  st = { scopes: new Map([
    [a, [row(s, "signal", "project", { ...plans, repo: a }), row(s, "atlas", "project", { lead: "up to 3 worker helpers, one level", repo: a }),
      row(s, "forge", "project", { effort: "medium", repo: a }), row(s, "warden", "project", { fit: "read-only; answers with a report", skills: ["review-checklist"], repo: a }), ...mine, ...bundled]],
    [b, [row(s, "beacon", "project", { ...plans, repo: b }), row(s, "pixel", "project", { model: "gpt-5-codex", effort: null, provider: "codex", repo: b }),
      row(s, "quill", "project", { tags: ["docs"], model: "claude-sonnet-5-5", repo: b }), ...mine, ...bundled]],
    ["", [...mine, ...bundled]],
  ]), details: new Map(), personas: new Map(), conflicted: false };
  for (const [scope, rows] of st.scopes) for (const r of rows) {
    if (r.source === "bundled") continue;
    const k = r.source === "user" ? `|${r.name}` : `${scope}|${r.name}`;
    if (!st.details.has(k)) st.details.set(k, { profile: r, fields: fields(r), rev: `rev-${r.name}-1`, n: 1 });
    if (!st.personas.has(k)) st.personas.set(k, { file: r.path.replace(/[^/]+$/, "SOUL.md"), layer: r.source, editable: true, why: null, trusted: true, hash: `sha256:${r.name}-1`,
      text: r.name === "security-critic" ? "You are Security critic. You read a change against the goal it was made for and look for what an attacker would use. You never edit code."
        : `You are ${r.title ?? r.name}. You take one part of the goal, make it work with its tests, and hand back what changed and what you checked.` });
  }
  states.set(s.name, st);
  return st;
}

const runOptions = {
  drivers: [{ provider: "claude", label: "Claude Code", model: "claude-opus-5-5", available: true, reason: null, default: true, efforts: ["low", "medium", "high", "xhigh"], effort: "high",
    models: [{ id: "claude-opus-5-5", name: "Opus 5.5", note: "Most capable" }, { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "Fast" }] },
  { provider: "codex", label: "Codex", model: "gpt-5-codex", available: true, reason: null, default: false, efforts: ["low", "medium", "high"], effort: "medium",
    models: [{ id: "gpt-5-codex", name: "GPT-5 Codex", note: "Codex" }] }],
  sandboxes: [{ name: "docker", label: "This Mac", available: true, reason: null, default: false }, { name: "boxd", label: "Cloud", available: true, reason: null, default: true }],
};

/** The routes; null when the request isn't one of them (the server goes on). */
export async function profilesRoute(url: URL, s: ProfilesScene, req: Request): Promise<Response | null> {
  const p = url.pathname, has = (c: string) => s.caps.includes(c), st = state(s);
  if (p === "/v1/projects/known" && has("projects.known")) return Response.json({ projects: PROJECTS });
  if (p === "/v1/run-options" && has("runs.options")) return Response.json(runOptions);
  const repo = url.searchParams.get("repo") ?? "";
  if (repo && !st.scopes.has(repo)) return p.startsWith("/v1/profiles") ? err(422, "invalid", `${repo} is not a capcomd project`) : null;
  if (p === "/v1/profiles" && has("profiles")) {
    const rows = st.scopes.get(repo)!.map((r) => r.source === "bundled" ? r : (st.details.get(r.source === "user" ? `|${r.name}` : `${repo}|${r.name}`)?.profile ?? r));
    return Response.json({ file: repo ? `${repo}/.capcomd/agents.json` : "/Users/dev/.capcomd/agents.json", layers: [], default: null, profiles: rows, warnings: [], error: null });
  }
  const m = p.match(/^\/v1\/profiles\/([a-z0-9_-]+)(\/work|\/persona)?$/);
  if (!m) return null;
  const [, name, tail] = m;
  const scoped = st.scopes.get(repo)!.find((r) => r.name === name);
  const key = scoped?.source === "user" ? `|${name}` : `${repo}|${name}`;
  const d = st.details.get(key);
  if (!tail && has("profiles.edit")) {
    if (!d) return err(404, "not_found", `profile "${name}" not found`);
    if (req.method === "GET") return Response.json({ profile: d.profile, fields: d.fields, rev: d.rev, writesTo: d.profile.path, warnings: [] });
    if (req.method !== "PUT") return null;
    const key8 = req.headers.get("idempotency-key");
    if (!key8 || key8.length < 8) return err(422, "invalid", "Idempotency-Key header required (8-200 chars)");
    const body: any = await req.json();
    if (s.conflictOnce && !st.conflicted) { st.conflicted = true; d.n += 1; d.rev = `rev-${name}-${d.n}`; return err(409, "conflict", `profile "${name}" changed since it was read: read it again, then retry`, { rev: d.rev }); }
    if (body?.rev !== d.rev) return err(409, "conflict", `profile "${name}" changed since it was read: read it again, then retry`, { rev: d.rev });
    const changes: any[] = [];
    for (const [id, v] of Object.entries<any>(body.values ?? {})) {
      const f = d.fields.find((x) => x.id === id);
      if (id === "identity.avatar.seed") { changes.push({ path: id, from: d.profile.avatarSeed ?? null, to: v }); d.profile = { ...d.profile, avatarSeed: v }; continue; }
      if (!f) return err(422, "invalid", `${id} is not a value of this profile`, { field: id });
      if (f.type === "number" && v !== null && !/^\d+(\.\d+)?$/.test(v)) return err(422, "invalid", `${f.label} must be a number`, { field: id });
      changes.push({ path: id, from: f.value, to: v });
      f.value = v; f.source = v === null ? "unset" : "profile";
      f.display = v === null ? f.display : f.type === "number" ? (id.endsWith("Ms") ? `${Number(v) / 60_000} min` : id === "limits.maxTurns" ? `${v} turns` : v)
        : f.choices.find((c: any) => c.value === v)?.label ?? v;
      if (id === "identity.title") d.profile = { ...d.profile, title: v };
      if (id === "harness.model") d.profile = { ...d.profile, model: v };
      if (id === "harness.effort") d.profile = { ...d.profile, effort: v };
    }
    d.n += 1; d.rev = `rev-${name}-${d.n}`; d.profile = { ...d.profile, version: d.profile.version + 1 };
    return Response.json({ profile: d.profile, fields: d.fields, rev: d.rev, writesTo: d.profile.path, warnings: [], changed: changes.length > 0, changes });
  }
  if (tail === "/work" && has("profiles.work")) {
    const now = Date.now(), limit = Number(url.searchParams.get("limit") ?? 5);
    return Response.json({ items: [
      { agentId: `agt-${name}-1`, runId: "run-demo", title: "review invoice rounding", project: "fix proration", outcome: "found_issues", endedAt: new Date(now - 2 * 3_600_000).toISOString(), updatedAt: new Date(now - 2 * 3_600_000).toISOString() },
      { agentId: `agt-${name}-2`, runId: "run-demo", title: "review email join", project: "migrate matchkey", outcome: "passed", endedAt: new Date(now - 5 * 3_600_000).toISOString(), updatedAt: new Date(now - 5 * 3_600_000).toISOString() },
    ].slice(0, limit) });
  }
  if (tail === "/persona" && has("profiles.persona")) {
    const pe = st.personas.get(key);
    if (!pe) return err(404, "not_found", `profile "${name}" not found`);
    if (req.method === "GET") return Response.json(pe);
    if (req.method !== "PUT") return null;
    const body: any = await req.json();
    if (body?.rev !== pe.hash) return err(409, "conflict", `${name}'s persona changed since it was read`, { rev: pe.hash });
    if (typeof body.text !== "string") return err(422, "invalid", "text must be a string", { field: "text" });
    pe.text = body.text; pe.hash = `sha256:${name}-${body.text.length}`;
    return Response.json(pe);
  }
  return null;
}
