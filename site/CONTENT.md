# Site content: sources and samples

Every claim on the page comes from the repository. When a source changes, update the page. Paths are relative to
the repo root.

## Where the claims come from

| Section | Claims | Source |
|---|---|---|
| Hero | durable orchestration for swarms of coding agents; Claude Code and Codex agents in parallel, one VM and branch each; only the exact commit that passed checks and a reviewer merges, once; MIT; one executable for macOS and Linux, arm64 and x64; the Homebrew install | README intro, "Quickstart", "Each release has the binaries…"; LICENSE; package.json (version, shown as 0.6) |
| Spawn, await, verify, merge | durable actors on Rivet; idempotent recorded transitions; crash/restart resumes; retried call never acts twice; exactly-once merge; chaos suite at named points and at random; who the orchestrator is; primitives, not a workflow; agents keep working after the driver's session ends | README "What you get", "Core concepts"; docs/durability.md; plugins/capcomd/skills/capcomd-orchestration/SKILL.md |
| The five stages | `run new` takes its gates from the project, and the driver picks check names, never commands; `spawn --key`; `verify` on the branch merged with the latest target, in a throwaway VM with no credentials; a contract from a VM can't carry checks; a read-only reviewer that never pushes, where no verdict is a fail; `merge --require` lands the verified commit by compare-and-swap; a protected target parks the merge for approval (CLI, menu bar app, or the driver's client where the project allows it) | README "Verification you control", "Review by another agent", "Safety model"; STATUS.md table (verify/merge, reviewer, checks in a VM, protected targets); SKILL.md (MCP section); docs/durability.md (merge CAS) |
| One agent, one VM, one branch | the provider interface operations; boxd first and verified live; unrestricted in the VM by default, narrowed by profiles; the boxd vs Docker table; credentials (snapshots scrubbed, short-lived git credential, checks VM holds none); checkpoints to `refs/capcomd/checkpoints/<agent>` (10 min, after a commit, each quarter of a budget, deleted on merge); `spawn --continue` | README "Isolation", "VMs come from a sandbox provider", "Safety model"; docs/providers.md; STATUS.md (supervisor, checkpoints); docs/agents.md |
| Roles are profiles | profile fields and `children`; narrow-only; `agents schema`, `agents validate`; what `capcomd setup project` writes (worker per provider, read-only reviewer with its tool list plus the check, planner that may spawn only the workers, `default` set to the first profile, no limits); the reviewer is spawned by the caller's `verify`, so it sits under the planner in the tree | docs/agents.md; src/agents/profiles.ts (schema); src/config/project-setup.ts (`planProject`) |
| How they talk | `send` (Claude reads at its next step; Codex can't while it runs); `handoff`, `result`; task board with leases, epochs and ordering; kv with compare-and-swap; events; fencing and capability tokens; **not yet**: leaves get the board, kv and inbox only when they may spawn, and sibling messaging within one parent is planned | SKILL.md; README "Agents that delegate, safely"; ROADMAP.md §3 ("Leaf agents can't coordinate") |
| What breaks at scale | the seven problem/mechanism pairs | README "Why" and "What you get"; docs/agents.md (stuck notices, pauses); STATUS.md (live spend); README "A real run" (13 VMs, all cleaned up) |
| Seven patterns | the seven patterns and when to use each; no built-in compare yet; stacked branches not supported; report agents | SKILL.md §1–7; README "Core concepts" (Report) |
| A live run | 2026-10-21; three broken functions, one failing test each; 2 Claude workers + 1 Codex worker; 3 of 3 merged, suite green; 7 agents; 13 VMs; 228 s; $0 billed, about $0.37 at API prices | README "A real run" |
| Drive it from your agent | the integrations table and each row's status; `relay.v1`, stable exit codes; `tui`, `logs --follow`, `tree`; the menu bar app is macOS only and built from source; the install commands; the early-release line | README "Connecting your agent", "Integrations", "Quickstart"; apps/menubar/README.md; STATUS.md |

## Sample content to confirm or replace

The pictures of the app are rebuilt in HTML from the approved mockups (`apps/menubar/design/`). They're
illustrations, not captures, and they show the menu bar app as it is on `main` (its Active card redesign is under
`## Unreleased` in CHANGELOG.md). The page says so in a note above the stages. These details in them are samples:

- The project chip "my-app", the menu bar date and time ("Wed 28 Oct", "9:41"), and the elapsed times on the cards
  (0:12, 2:05, 2:58, 3:41, "asked 18s ago").
- "Add rate limiting to the API · Merged into main" in Recent. The goal comes from the README, but that finished run is
  illustrative.
- The approval card's files and counts: `src/parser.ts +11 −2`, `src/parser.test.ts +6 −0`.
- The agents' short suffixes ("worker 3f1a"), derived from the run id the way the app suffixes sibling agents. They change with every crew.
- In the roles section, `lead` and `triage` are example profiles. The file says so in its title bar and in the note
  under it.
- The tree's `bun test` check in the example `agents.json` reviewer tools: it's what setup adds for a project whose
  check is `bun test`.

## Open decisions (defaults used)

- The domain: `lib/site.ts` → `SITE_URL` is the placeholder `https://capcomd.example`. Canonical, Open Graph,
  robots and sitemap URLs use it.
- Hosting: none chosen. `out/` (the Next.js static export) is a plain static folder.
- Footage: none recorded. The rebuilt panels are the product imagery.
- The name: the site doesn't explain what CAPCOM means.
- Bot names: not used. Agents are named by role, plus a short suffix in the panels, as in the app's tree.
