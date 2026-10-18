/**
 * Protected merge targets. Merges into these park in `awaiting_approval`
 * until `relay approve`. Configure with RELAY_PROTECTED_BRANCHES
 * (comma-separated, `*` suffix globs). Default: main, master, release/*.
 */
export function protectedPatterns(): string[] {
  const raw = process.env.RELAY_PROTECTED_BRANCHES ?? "main,master,release/*";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isProtectedBranch(branch: string | undefined | null): boolean {
  if (!branch) return false;
  return protectedPatterns().some((p) =>
    p.endsWith("*") ? branch.startsWith(p.slice(0, -1)) : branch === p
  );
}
