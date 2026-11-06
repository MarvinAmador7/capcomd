// The host's token signing key (src/subagents/token.ts) is capcomd state like the rest: it lives in the capcomd home
// ($CAPCOMD_HOME/rpc.key, ~/.capcomd/rpc.key for an installed CLI, <repo>/.relay/rpc.key in a dev checkout), so a
// custom CAPCOMD_HOME or a checkout never signs with (or creates) the user's real ~/.capcomd/rpc.key.
// CAPCOMD_RPC_KEY_FILE names another file, CAPCOMD_RPC_KEY gives the key itself.
import { expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { rpcKeyFile } from "../../src/subagents/token";
import { capcomdHome, homeFile, PACKAGE_ROOT } from "../../src/utils/home";

const TOKEN_TS = new URL("../../src/subagents/token.ts", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "capcomd-rpc-key-"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** signingKey() in a fresh process (the key is cached per process); prints the key's hash, never the key. */
function signingKeyIn(env: Record<string, string | undefined>): string {
  const script = join(dir, "sign.ts");
  writeFileSync(script, [
    `import { createHash } from "crypto";`,
    `import { mint, signingKey, verifyToken } from ${JSON.stringify(TOKEN_TS)};`,
    `const { token } = mint({ run: "run-1", sub: "agt-1", ops: ["status"] });`,
    `if (!verifyToken(token).ok) throw new Error("own token not verified");`,
    `console.log(createHash("sha256").update(signingKey()).digest("hex"));`,
  ].join("\n"));
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of ["CAPCOMD_RPC_KEY", "CAPCOMD_RPC_KEY_FILE", "RELAY_RPC_KEY", "RELAY_RPC_KEY_FILE"]) delete base[k];
  const merged = Object.fromEntries(Object.entries({ ...base, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const r = Bun.spawnSync([process.execPath, script], { env: merged, cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`signingKey failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

test("with CAPCOMD_HOME the key is created at $CAPCOMD_HOME/rpc.key (0600), never under ~/.capcomd", () => {
  const home = join(dir, "custom-home"), user = join(dir, "user");
  const hash = signingKeyIn({ CAPCOMD_HOME: home, HOME: user });
  const key = join(home, "rpc.key");
  expect(existsSync(key)).toBe(true);
  expect(statSync(key).mode & 0o777).toBe(0o600);
  expect(sha(readFileSync(key, "utf8").trim())).toBe(hash);
  expect(existsSync(join(user, ".capcomd"))).toBe(false);
  // The next process signs with the same key; another home is another key.
  expect(signingKeyIn({ CAPCOMD_HOME: home, HOME: user })).toBe(hash);
  expect(signingKeyIn({ CAPCOMD_HOME: join(dir, "other-home"), HOME: user })).not.toBe(hash);
});

test("CAPCOMD_RPC_KEY_FILE still names the key file, wherever the home is", () => {
  const home = join(dir, "home-with-file"), file = join(dir, "elsewhere", "signing.key");
  const hash = signingKeyIn({ CAPCOMD_HOME: home, HOME: join(dir, "user"), CAPCOMD_RPC_KEY_FILE: file });
  expect(sha(readFileSync(file, "utf8").trim())).toBe(hash);
  expect(existsSync(join(home, "rpc.key"))).toBe(false);
});

test("the key file is a home file: <home>/rpc.key, so an installed CLI keeps ~/.capcomd/rpc.key", () => {
  expect(rpcKeyFile({ CAPCOMD_HOME: "/x/home" })).toBe("/x/home/rpc.key");
  expect(rpcKeyFile({ CAPCOMD_HOME: "/x/home", CAPCOMD_RPC_KEY_FILE: "/k/f" })).toBe("/k/f");
  // This is a checkout: without CAPCOMD_HOME the key stays with its other state.
  expect(rpcKeyFile({})).toBe(join(PACKAGE_ROOT, ".relay", "rpc.key"));
  expect(rpcKeyFile({})).toBe(homeFile("rpc.key", {}));
  // Outside a checkout the home with no CAPCOMD_HOME is ~/.capcomd: the key's old, unchanged path.
  expect(join(capcomdHome({}), "rpc.key")).toBe(join(homedir(), ".capcomd", "rpc.key"));
});
