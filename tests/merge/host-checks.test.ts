// Checks on the host (fake sandboxes) run without the operator's credentials, but with their toolchain.
import { expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Git } from "../../src/merge/git";
import { hostCheckEnv, runTests } from "../../src/merge/verify";

test("hostCheckEnv drops capcomd settings, keys, tokens, git credential config and the SSH agent; keeps the toolchain", () => {
  const env = hostCheckEnv({
    PATH: "/usr/bin", HOME: "/home/me", BUN_INSTALL: "/home/me/.bun", LANG: "C.UTF-8", NODE_ENV: "test",
    BOXD_API_KEY: "bxd_x", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk", GH_TOKEN: "ghp", GITHUB_TOKEN: "ghs",
    CAPCOMD_REPO: "https://github.com/a/b", CLAUDE_CODE_OAUTH_TOKEN: "t", NPM_TOKEN: "n", MY_SERVICE_SECRET: "s",
    DB_PASSWORD: "p", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_ASKPASS: "/x", SSH_AUTH_SOCK: "/tmp/agent",
    AWS_ACCESS_KEY_ID: "a", STRIPE_KEY: "k",
  });
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me", BUN_INSTALL: "/home/me/.bun", LANG: "C.UTF-8", NODE_ENV: "test" });
});

test("a host check doesn't see BOXD_API_KEY, and gets the run's ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-hostcheck-"));
  await new Git(dir).ok(["init", "-q"]);
  const saved = process.env.BOXD_API_KEY;
  process.env.BOXD_API_KEY = "bxd_should_not_leak";
  try {
    const r = await runTests(new Git(dir), "env", { CAPCOMD_RUN_ID: "run-1" });
    expect(r.passed).toBe(true);
    expect(r.output).not.toContain("bxd_should_not_leak");
    expect(r.output).toContain("CAPCOMD_RUN_ID=run-1");
    expect(r.output).toContain("PATH=");
  } finally { if (saved === undefined) delete process.env.BOXD_API_KEY; else process.env.BOXD_API_KEY = saved; }
});
