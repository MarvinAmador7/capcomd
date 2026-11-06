// Plugin API §11.7: the host runs git that talks to a remote only through src/merge/host-git.ts (remoteGit in a host
// repo it checks, lsRemote outside any repository, fetchBundle for a sandbox's bundle), and no git credential is made
// anywhere else. This fails when a new call spells a network git command (fetch, push, ls-remote, clone, pull) any
// other way, or builds a credential helper outside host-git.ts. A call that has to be an exception is listed below,
// with the reason it can't reach an agent-editable checkout.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..", "..");
const SCAN = ["src", "packages/plugin/src", "plugins"];
const OPS = "fetch|push|ls-remote|clone|pull";

/** Where a network git command may be spelled outside host-git.ts, and why. */
const EXCEPTIONS: Record<string, string> = {
  // The in-VM CLI's own command table: `["fetch", "<help>", …]` names capcomd's `fetch` op, which asks the host.
  "src/subagents/vm-cli.mjs": "capcomd fetch's entry in the in-VM CLI's command table, not a git argv",
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|mts|mjs|js)$/.test(e) && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Comments out: a comment may name a command. Strings stay (a command is a string). */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));

const CALLS = ["remoteGit(", "lsRemote(", "fetchBundle(", ".run(", ".ok(", "spawn(", "spawnSync(", "execFile(", "execFileSync(", "exec(", "git(", "Bun.spawn("];
/** The call a match is an argument of: the nearest call opened before it (within a statement's reach). */
function callOf(text: string, at: number): string | null {
  const before = text.slice(Math.max(0, at - 400), at);
  let best: { name: string; i: number } | null = null;
  for (const c of CALLS) { const i = before.lastIndexOf(c); if (i >= 0 && (!best || i > best.i || (i === best.i && c.length > best.name.length))) best = { name: c, i }; }
  return best?.name ?? null;
}

export function networkGitSites(): Array<{ file: string; line: number; text: string; via: string | null }> {
  const sites: Array<{ file: string; line: number; text: string; via: string | null }> = [];
  // An argv whose subcommand is a network op: ["push", …], ["git", "-c", "k=v", "push", …], "git", ["push", …].
  const argv = new RegExp(String.raw`\[\s*(["'\`])(${OPS})\1\s*[,\]]|\[\s*(["'\`])git\3\s*,(?:\s*(["'\`])[^"'\`\n]*\4\s*,)*?\s*(["'\`])(${OPS})\5|(["'\`])git\7\s*,\s*\[\s*(["'\`])(${OPS})\8`, "g");
  for (const dir of SCAN) for (const f of files(join(ROOT, dir))) {
    const rel = relative(ROOT, f);
    const text = code(readFileSync(f, "utf8"));
    for (const m of text.matchAll(argv)) {
      const line = text.slice(0, m.index).split("\n").length;
      sites.push({ file: rel, line, text: m[0], via: callOf(text, m.index!) });
    }
  }
  return sites;
}

describe("host git lint (plugin API §11.7)", () => {
  test("every network git command on the host goes through src/merge/host-git.ts", () => {
    const bad = networkGitSites().filter((s) => s.file !== "src/merge/host-git.ts" && !EXCEPTIONS[s.file] && s.via !== "remoteGit(" && s.via !== "lsRemote(" && s.via !== "fetchBundle(");
    expect(bad.map((s) => `${s.file}:${s.line} ${s.text} (in ${s.via ?? "?"})`)).toEqual([]);
  });

  test("the lint sees the shapes a bypass would take", () => {
    const probe = code(`const a = new Git(d).run(["push", "origin", x]); spawnSync("git", ["ls-remote", u]); p.exec(id, ["git", "-c", "a=b", "fetch", "origin"]);
      // git.run(["push"]) in a comment is not code
      await remoteGit(git, ["push", "--porcelain", url, ref], url);`);
    const argv = new RegExp(String.raw`\[\s*(["'\`])(${OPS})\1\s*[,\]]|\[\s*(["'\`])git\3\s*,(?:\s*(["'\`])[^"'\`\n]*\4\s*,)*?\s*(["'\`])(${OPS})\5|(["'\`])git\7\s*,\s*\[\s*(["'\`])(${OPS})\8`, "g");
    const hits = [...probe.matchAll(argv)].map((m) => callOf(probe, m.index!));
    expect(hits).toEqual([".run(", "spawnSync(", "exec(", "remoteGit("]);
  });

  test("no git credential is built outside host-git.ts, and no sandbox provider takes one", () => {
    const cred = /CAPCOMD_GIT_TOKEN|credential\.[A-Za-z0-9:/._-]*helper|GIT_CONFIG_KEY_|GIT_ASKPASS\s*:|gitCredentials|GitCredentialHook/;
    const found: string[] = [];
    for (const dir of SCAN) for (const f of files(join(ROOT, dir))) {
      const rel = relative(ROOT, f);
      if (rel === "src/merge/host-git.ts") continue;
      code(readFileSync(f, "utf8")).split("\n").forEach((l, i) => { if (cred.test(l)) found.push(`${rel}:${i + 1} ${l.trim().slice(0, 160)}`); });
    }
    expect(found).toEqual([]);
  });
});
