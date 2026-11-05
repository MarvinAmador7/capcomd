// The mode-consistency check (docs/spec/plugin-api.md §14.4, ADR-023 step 1): every `hooks.fire(` site in src/ names
// a known hook and the mode HOOKS declares for it, both as string literals, so a hook can't quietly be fired as the
// wrong mode (an observe hook awaited for a decision, a gate fired as observe). `bun scripts/check-hook-modes.ts [dir]`
// exits 1 on any problem; tests/plugins/host.test.ts runs it in test:fast.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HOOKS, type HookName } from "../packages/plugin/src/hooks";

export type HookSite = { file: string; line: number; hook: string | null; mode: string | null };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n.startsWith(".")) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mts)$/.test(n) ? [p] : [];
  });
}

/** Every `hooks.fire(` call under `dir`, with its literal hook name and mode (null when not a literal). */
export function hookSites(dir: string): HookSite[] {
  const sites: HookSite[] = [];
  for (const f of files(dir)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\bhooks\s*\.\s*fire\s*(?:<[^>]*>)?\s*\(/g)) {
      const args = /^\s*(["'`])([^"'`]*)\1\s*,\s*(["'`])([^"'`]*)\3/.exec(text.slice(m.index! + m[0].length));
      sites.push({ file: relative(process.cwd(), f), line: text.slice(0, m.index).split("\n").length, hook: args?.[2] ?? null, mode: args?.[4] ?? null });
    }
  }
  return sites;
}

/** Problems with the sites under `dir`: one line each, empty when every site is right. */
export function checkHookModes(dir: string): string[] {
  return hookSites(dir).flatMap((s) => {
    const at = `${s.file}:${s.line}`;
    if (s.hook === null || s.mode === null) return [`${at}: hooks.fire( needs the hook name and the mode as string literals`];
    if (!(s.hook in HOOKS)) return [`${at}: unknown hook ${s.hook}`];
    const want = HOOKS[s.hook as HookName].mode;
    return s.mode === want ? [] : [`${at}: ${s.hook} is ${want === "observe" ? "an" : "a"} ${want} hook, fired as ${s.mode}`];
  });
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "..", "src");
  const problems = checkHookModes(dir);
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log(`hook modes: ${hookSites(dir).length} fire site(s) under ${relative(process.cwd(), dir) || "."}, all consistent with HOOKS`);
}
