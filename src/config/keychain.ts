// The boxd API key in the OS keychain: macOS Keychain (`security`), or the Linux Secret Service
// (`secret-tool`, libsecret). The value is passed on stdin, never on a command line (no process-list leak).
import { spawnSync } from "child_process";

const SERVICE = "capcomd.boxd";
const ACCOUNT = "capcomd";
export type Keychain = "macos" | "secret-service";
export type Runner = (cmd: string, args: string[], input?: string) => { code: number; stdout: string };
const run: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
};
const has = (cmd: string, r: Runner) => r("sh", ["-c", `command -v ${cmd}`]).code === 0;

export function keychainKind(r: Runner = run, platform = process.platform): Keychain | null {
  if (platform === "darwin" && has("security", r)) return "macos";
  if (platform === "linux" && has("secret-tool", r)) return "secret-service";
  return null;
}

const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;

/** Store (or replace) the key. */
export function keychainSet(value: string, r: Runner = run, kind = keychainKind(r)): void {
  if (!kind) throw new Error("no OS keychain available (macOS Keychain or Linux secret-tool)");
  const res = kind === "macos"
    ? r("security", ["-i"], `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -l ${q("capcomd boxd API key")} -w ${q(value)}\n`)
    : r("secret-tool", ["store", "--label=capcomd boxd API key", "service", SERVICE, "account", ACCOUNT], value);
  if (res.code !== 0) throw new Error(`could not store the key in the ${kind === "macos" ? "macOS Keychain" : "Secret Service"}`);
}

/** The stored key, or null. */
export function keychainGet(r: Runner = run, kind = keychainKind(r)): string | null {
  if (!kind) return null;
  const res = kind === "macos"
    ? r("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"])
    : r("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
  const v = res.stdout.trim();
  return res.code === 0 && v ? v : null;
}

export function keychainDelete(r: Runner = run, kind = keychainKind(r)): void {
  if (!kind) return;
  if (kind === "macos") r("security", ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]);
  else r("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
}
