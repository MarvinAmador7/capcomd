// The GitHub REST adapter is forge-github's (src/plugins/forges/github-rest.ts, docs/spec/plugin-api.md §15.2). Kept
// here for the tests that build one (HttpGitHub against tests/merge/fake-github.ts) and the agents' push credential.
export { GitHubHttpError, HttpGitHub, githubAt, githubToken, hasGitHubOverride, setGitHubApi } from "../plugins/forges/github-rest";
export type { GitHubApi, MergeResult, PullRequest } from "../plugins/forges/github-rest";
