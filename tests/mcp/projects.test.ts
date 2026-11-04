// An agent sets a project up and uses it in the same session: `capcomd setup project` puts the checkout on the projects
// list a running `capcomd mcp` reads (no restart), and capcomd_setup {project} reports the sandbox that project's runs
// will use, with where it comes from (the project's .capcomd/config.json over the user config's).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLI } from "../helpers/engine";

let mcp: Client;
let env: Record<string, string>;
const root = realpathSync(mkdtempSync(join(tmpdir(), "capcomd-mcp-projects-")));
const home = join(root, "home");
const away = join(root, "away");
const repo = join(root, "tinycalc");

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res: any = await mcp.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
};

beforeAll(async () => {
  mkdirSync(join(home, ".capcomd"), { recursive: true });
  mkdirSync(away);
  mkdirSync(repo);
  // The user's config says boxd (as `capcomd setup accounts` writes it).
  writeFileSync(join(home, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: "boxd" } }));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/tinycalc.git"], { cwd: repo });
  env = { ...(process.env as Record<string, string>), HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), CAPCOMD_NO_CONFIG: "", CAPCOMD_NO_ENGINE_AUTOSTART: "1",
    CAPCOMD_ENDPOINT: "http://127.0.0.1:9", CAPCOMD_DOCKER_BIN: "/nonexistent/docker", GIT_SSH_COMMAND: "false", BOXD_API_KEY: "" };
  delete env.CAPCOMD_SANDBOX; delete env.RELAY_SANDBOX;
  mcp = new Client({ name: "projects-test", version: "0.0.1" });
  // The session started somewhere else (its folder isn't the project yet).
  await mcp.connect(new StdioClientTransport({ command: "bun", args: [CLI, "mcp"], cwd: away, stderr: "ignore", env }));
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(root, { recursive: true, force: true });
});

test("no projects: the hint names the command that adds one; after setup project it's listed without a restart", async () => {
  const before = (await call("capcomd_projects")).body;
  expect(before.projects).toEqual([]);
  expect(before.next).toContain("capcomd setup project --yes");
  expect(before.next).toContain("no restart");

  const p = Bun.spawnSync(["bun", CLI, "setup", "project", "--yes", "--mode", "pr", "--target", "dev", "--check", "true", "--sandbox", "docker", "--json"], { cwd: repo, env });
  expect(p.exitCode).toBe(0);

  const after = (await call("capcomd_projects")).body;
  expect(after.projects).toEqual([{ name: "tinycalc", path: repo, default: true, ready: true }]);
  expect(after.default).toBe("tinycalc");
}, 60_000);

test("capcomd_setup {project}: the sandbox that project's runs use, its source, and that sandbox's readiness", async () => {
  const r = await call("capcomd_setup", { project: "tinycalc" });
  expect(r.isError).toBe(false);
  const s = r.body;
  expect(s.project).toBe("tinycalc");
  expect(s.sandbox).toEqual({ name: "docker", source: "project", path: join(repo, ".capcomd", "config.json") });
  const step = (n: string) => s.steps.find((x: any) => x.step === n);
  expect(step("sandbox")).toMatchObject({ ok: true, detail: `docker (project: ${join(repo, ".capcomd", "config.json")})` });
  // Docker's own checks, not boxd's: Docker isn't answering here, and there's no env image with a warm checkout yet.
  expect(step("docker")).toMatchObject({ ok: false, hint: expect.stringContaining("Start Docker") });
  expect(step("boxd key")).toBeUndefined();
  expect(step("env image")).toMatchObject({ ok: true, advice: true, command: "capcomd env build --sandbox docker" });
  // Asked through capcomd's MCP server, which this session has: the plugin is advice at most, never "not ready".
  expect(step("agent plugin")).toMatchObject({ ok: true });
  // The capacity of the sandbox this project's runs use, not the server process's default.
  expect(s.capacity.sandbox).toBe("docker");
  expect(s.ready).toBe(false);
  expect(s.next).toContain("docker:");
  expect(s.gates).toMatchObject({ checks: { unit: "true" }, target: "dev" });
}, 60_000);
