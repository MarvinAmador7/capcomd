import type { GitCredentialHook } from "../providers/boxd";
import { githubToken } from "../merge/github";

/**
 * Git credential hook for VMs: the GitHub token rides in the env of one `git` exec only,
 * via an inline credential helper (GIT_CONFIG_*). Nothing is written to disk in the VM,
 * the remote URL stays token-free, and the agent process never sees the token.
 */
export function githubGitCredentials(getToken: () => Promise<string> = githubToken): GitCredentialHook {
  return async ({ cmd }) => {
    if (!["clone", "fetch", "push", "ls-remote", "pull"].includes(cmd[1] ?? "")) return null;
    let token: string;
    try { token = await getToken(); } catch { return null; } // no token: public repos still work; private ones fail with git's own error
    return {
      CAPCOMD_GIT_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$CAPCOMD_GIT_TOKEN"; }; f',
    };
  };
}
