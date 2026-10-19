import type { Git } from "./git";

/** Run the repo's test command in the merged worktree. No command configured = pass (reported). */
export async function runTests(git: Git, command: string, env: Record<string, string>): Promise<{ passed: boolean; output: string }> {
  if (!command.trim()) return { passed: true, output: "(no test command configured)" };
  const proc = Bun.spawn(["sh", "-c", command], { cwd: git.cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { passed: code === 0, output: (out + err).slice(-4000) };
}
