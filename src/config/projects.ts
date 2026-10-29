// The projects one capcomd MCP server serves (P1b of docs/proposals/hermes.md): a list in the user config
// (~/.capcomd/config.json `projects`), so a front door like Hermes needs one `mcp_servers.capcomd` entry for all of
// the user's repositories instead of one entry pinned to a folder. `capcomd setup agent` adds the checkout it runs in.
// A project is a checkout with a .capcomd/config.json (its gates, driver policy and agent profiles).
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, resolve } from "path";
import { projectConfigPath, readConfig, userConfigPath, writeConfig, type ProjectEntry } from "./store";

type Source = Record<string, string | undefined>;

export interface Projects { default: string | null; list: ProjectEntry[] }

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
export const samePath = (a: string, b: string) => real(a) === real(b);
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** The configured projects (user config). Entries without a name or path are skipped. */
export function readProjects(env: Source = process.env): Projects {
  const p = readConfig(userConfigPath(env)).projects ?? {};
  const list = (Array.isArray(p.list) ? p.list : []).filter((x): x is ProjectEntry => !!x && typeof x.name === "string" && !!x.name && typeof x.path === "string" && !!x.path);
  return { default: typeof p.default === "string" && list.some((x) => x.name === p.default) ? p.default : null, list };
}

/** The checkout that holds the nearest .capcomd/config.json from `cwd` (never capcomd's own user config), or null. */
export function projectDirOf(cwd: string, env: Source = process.env): string | null {
  const f = projectConfigPath(cwd, env);   // never capcomd's user config
  return f ? dirname(dirname(f)) : null;
}

/** A project's name: its configured one, else its folder's name. */
export function projectNameOf(path: string, env: Source = process.env): string {
  return readProjects(env).list.find((x) => samePath(x.path, path))?.name ?? safeName(basename(path));
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";

/** A name for a new project at `path`, unique in `list`. */
export function nameFor(path: string, list: ProjectEntry[]): string {
  const base = safeName(basename(path));
  let name = base;
  for (let i = 2; list.some((x) => x.name === name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * Add the checkout at `path` to the list (once; its existing entry is kept). The first project becomes the default.
 * Returns the entry and what changed.
 */
export function addProject(path: string, env: Source = process.env): { project: ProjectEntry; added: boolean; madeDefault: boolean } {
  const cur = readProjects(env);
  const have = cur.list.find((x) => samePath(x.path, path));
  if (have) return { project: have, added: false, madeDefault: false };
  const project = { name: nameFor(path, cur.list), path: resolve(path) };
  const madeDefault = !cur.default;
  writeConfig(userConfigPath(env), { projects: { list: [...cur.list, project], ...(cur.default ? { default: cur.default } : { default: project.name }) } });
  return { project, added: true, madeDefault };
}

/** A project by name, else by path (the checkout, or a folder inside it); null when it isn't configured. */
export function findProject(arg: string, list: ProjectEntry[]): ProjectEntry | null {
  const byName = list.find((x) => x.name === arg);
  if (byName) return byName;
  if (!/[/~]/.test(arg) && !existsSync(arg)) return null;
  const p = expand(arg);
  return list.find((x) => samePath(x.path, p)) ?? null;
}
