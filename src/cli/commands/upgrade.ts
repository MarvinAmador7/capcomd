// `capcomd upgrade [--to X.Y.Z] [--dry-run]`: replace the single executable with a newer release (install.sh's
// download, from the running binary). Installs from npm or Homebrew upgrade the way they were installed.
import { createHash } from "crypto";
import { chmodSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { RelayError } from "../../core/errors";
import { capcomdHome, COMPILED, isDevCheckout } from "../../utils/home";
import { VERSION } from "../../utils/self";

export const REPO = "MarvinAmador7/capcomd";

/** This machine's release asset, as install.sh names it. */
export function assetName(platform = process.platform, arch = process.arch): string {
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) throw new RelayError("config", `no capcomd build for ${platform}-${arch}`, "Builds exist for macOS and Linux, x64 and arm64.");
  return `capcomd-${platform}-${arch}`;
}

/** How this capcomd was installed, which decides how it upgrades. */
export function installKind(execPath = process.execPath, compiled = COMPILED): "binary" | "homebrew" | "npm" | "checkout" {
  if (!compiled) return isDevCheckout() ? "checkout" : "npm";
  let real = execPath;
  try { real = realpathSync(execPath); } catch {}
  return /\/Cellar\/capcomd\//.test(real) ? "homebrew" : "binary";
}

/** a < b for X.Y.Z[-pre] versions (a prerelease sorts before its release). */
export function olderThan(a: string, b: string): boolean {
  const p = (v: string) => { const [core, pre] = v.replace(/^v/, "").split("-", 2); return { n: core!.split(".").map(Number), pre }; };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) < (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (!x.pre) return false;
  if (!y.pre) return true;
  return x.pre < y.pre;
}

async function get(url: string): Promise<Response> {
  const r = await fetch(url, { headers: { "user-agent": `capcomd/${VERSION}` }, redirect: "follow" });
  if (!r.ok) throw new RelayError("run_failed", `GET ${url}: ${r.status} ${r.statusText}`, "Check your network, or install by hand: curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh");
  return r;
}

export async function upgrade(o: { to?: string; dryRun?: boolean } = {}) {
  const kind = installKind();
  if (kind === "homebrew") return { current: VERSION, upgraded: false, how: "brew upgrade capcomd" };
  if (kind === "npm") return { current: VERSION, upgraded: false, how: "bun add -g capcomd@latest" };
  if (kind === "checkout") return { current: VERSION, upgraded: false, how: "git pull && bun install (a development checkout)" };
  const tag = o.to ? `v${o.to.replace(/^v/, "")}` : ((await (await get(`https://api.github.com/repos/${REPO}/releases/latest`)).json()) as { tag_name: string }).tag_name;
  const latest = tag.replace(/^v/, "");
  if (!o.to && !olderThan(VERSION, latest)) return { current: VERSION, latest, upgraded: false };
  if (o.dryRun) return { current: VERSION, latest, upgraded: false, dryRun: true };
  const name = assetName();
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const bin = Buffer.from(await (await get(`${base}/${name}`)).arrayBuffer());
  const want = (await (await get(`${base}/${name}.sha256`)).text()).trim().split(/\s+/)[0];
  const got = createHash("sha256").update(bin).digest("hex");
  if (got !== want) throw new RelayError("conflict", `checksum mismatch for ${name} ${tag} (expected ${want}, got ${got}); nothing was changed`, "Retry; if it persists, report it.");
  // Next to the running binary, then renamed over it: atomic, and a running capcomd (the engine) keeps its file.
  const self = realpathSync(process.execPath);
  const tmp = join(dirname(self), `.capcomd.${process.pid}.tmp`);
  writeFileSync(tmp, bin);
  chmodSync(tmp, 0o755);
  renameSync(tmp, self);
  // The engines extracted by older versions (~/.capcomd/bin/<version>/), except the running one's.
  const pruned: string[] = [];
  const cache = join(capcomdHome(), "bin");
  try { for (const v of readdirSync(cache)) if (/^\d+\.\d+\.\d+/.test(v) && v !== VERSION && v !== latest) { rmSync(join(cache, v), { recursive: true, force: true }); pruned.push(v); } } catch {}
  return { current: VERSION, latest, upgraded: true, path: self, ...(pruned.length ? { pruned } : {}), next: "Restart the engine to run the new version: `capcomd service install` (if it runs as a service), or restart `capcomd serve`." };
}
