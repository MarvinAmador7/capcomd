import { env } from "./env";
/**
 * Protected merge targets. Merges into these park in `awaiting_approval`
 * until `capcomd approve`. Configure with CAPCOMD_PROTECTED_BRANCHES (deprecated alias RELAY_PROTECTED_BRANCHES)
 * (comma-separated, `*` suffix globs). Default: main, master, release/*.
 */
export function protectedPatterns(source: Record<string, string | undefined> = process.env): string[] {
  const raw = env("PROTECTED_BRANCHES", source) ?? "main,master,release/*";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isProtectedBranch(branch: string | undefined | null, source: Record<string, string | undefined> = process.env): boolean {
  if (!branch) return false;
  return protectedPatterns(source).some((p) =>
    p.endsWith("*") ? branch.startsWith(p.slice(0, -1)) : branch === p
  );
}
