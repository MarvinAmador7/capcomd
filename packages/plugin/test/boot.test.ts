// `testkit.bootWith`'s environment (src/boot.ts, spec §14.3): the daemon it boots gets none of what would point it at the
// developer's own capcomd, logins or repository. The boot itself, against a real daemon, is
// tests/scenarios/plugin-slack-example.test.ts.
import { describe, expect, test } from "bun:test";
import { cleanEnv } from "../src/boot";

describe("bootWith's environment (§14.3)", () => {
  test("keeps the caller's PATH and the rest; drops capcomd's, its engine's, boxd's, GitHub tokens and git's", () => {
    const env = {
      PATH: "/usr/bin", HOME: "/Users/dev", BUN_OPTIONS: "--preload x", ANTHROPIC_API_KEY: "kept: no agent runs",
      CAPCOMD_HOME: "/Users/dev/.capcomd", CAPCOMD_ENDPOINT: "http://127.0.0.1:6420", RELAY_RPC_KEY_FILE: "k",
      RIVET_ENDPOINT: "e", RIVETKIT_STORAGE_PATH: "s", BOXD_API_KEY: "b", GITHUB_TOKEN: "g", GH_TOKEN: "h",
      // A test run from a git hook (husky and the like): git exports where the developer's repository is.
      GIT_DIR: "/Users/dev/app/.git", GIT_WORK_TREE: "/Users/dev/app", GIT_INDEX_FILE: "/Users/dev/app/.git/index",
      UNSET: undefined,
    };
    expect(cleanEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/Users/dev", BUN_OPTIONS: "--preload x", ANTHROPIC_API_KEY: "kept: no agent runs" });
  });
});
