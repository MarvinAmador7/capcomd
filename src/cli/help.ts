// The CLI's help (`capcomd --help`, `capcomd <command> --help`): the kernel's commands, its own and its built-in front
// doors' (src/plugins/front/). A plugin's command shows its own usage lines (src/cli/front-doors.ts).
import { SCHEMA } from "../core/errors";

export const HELP = `
capcomd - agent orchestration CLI

Usage:
  capcomd serve [--harness-socket PATH]  Start the Rivet engine (port 6420) and the harness.v1 API socket
  capcomd run <goal> [--run-id ID] [--base B] [--goal-branch G | --no-goal-branch] [--detach]
             [--profile NAME] [--set key=value]... [--overrides JSON] [--operator]
                                       Pick an agent profile; overrides only narrow it
                                       (e.g. --set children.maxDepth=1 --set maxTurns=10)
                                       unless --operator
                                       Start or resume a run (EXPERIMENTAL: the recipe's planner
                                       and judge still use a fake model; see STATUS.md)
  capcomd status <runId>                 Show run status
  capcomd cancel <runId>                 Cancel a run
  capcomd events <runId> [--cursor N] [--limit N]
                                       List lifecycle events (alias: replay)
  capcomd trace <runId>                  Show the span waterfall
  capcomd approve <runId> <taskId|mrgId> [--deny] [--reason R]
                                       Approve (or deny) a merge parked in awaiting_approval
  capcomd env build [--force]            Bake agent CLIs + repo deps into a snapshot (no secrets)
  capcomd env status | env rm [name|all] List / delete env snapshots (env, auth, doctor: --sandbox docker|boxd
                                       works on that sandbox instead of CAPCOMD_SANDBOX)
  capcomd profiles list|show|add|set|rm|schema|validate
                                       Named agent profiles: .capcomd/agents.json, and profile files
                                       (profile.yaml) in .capcomd/profiles/ and ~/.capcomd/profiles/ (docs/agents.md).
                                       show <name>: the files laid together and which one set each value;
                                       schema: a profile file's JSON Schema (schema v1: agents.json's).
                                       add, set and rm edit agents.json: provider, auth
                                       (apikey|subscription, exactly one), model, limits, prompts, tools.
                                       add/set flags: --provider --auth --model --effort --max-turns --budget
                                       --timeout-ms --idle-after-ms --stuck-repeats --no-change-after-ms --checkpoint-every-ms --sandbox --egress --system-prompt
                                       --append-system-prompt --allowed-tools --disallowed-tools
                                       --description --default --spec JSON --unset k1,k2
  capcomd agents …                     The old name of capcomd profiles, until the next minor release
                                       (agents schema: agents.json's; agents list --json: the rows under "agents")
  Primitives (ADR-016; all --json, stable ids, --key idempotent):
  capcomd run <goal> [--planner PROFILE]   a planner agent splits the goal into child agents, verifies and merges their work
                                           onto the run's goal branch: --goal-branch G (default: capcomd/<goal-slug>), cut
                                           from --base B (default: the project's target, else origin's default branch);
                                           reviewed work lands on it with no approval. --no-goal-branch: merge into the
                                           target (--target-branch) as before
  capcomd goal <runId> [--json]            the goal branch against its base: what landed, what didn't, the planner's summary
  capcomd pr open <runId> [--yes]          open a pull request from the goal branch into its base (your gh login; idempotent;
                                           capcomd never merges it; a run whose planner stopped asks first, --yes without a
                                           terminal)  ·  capcomd goal keep <runId>: keep the branch, no PR
  capcomd goal done <runId> [--summary S]  a run you drive yourself (no planner agent): its work is done, the goal
                                           branch is ready for a pull request (refused while an agent still works)
                                           (default on boxd: the profile named "planner", which capcomd setup writes)
             [--planner-provider claude|codex]  run the planner on that provider (its model and login: the project's
                                           profile on it, else the provider's defaults)
             [--planner-effort LEVEL]      the planner's reasoning effort (claude low..max, codex minimal..high)
             [--planner-model ID]          the planner's model (one its provider offers: GET /v1/run-options models;
                                           claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5; codex gpt-5.6)
             [--sandbox docker|boxd]       where this run's agents and checks run (default: CAPCOMD_SANDBOX)
  capcomd run <goal> [--recipe|--legacy]   (CAPCOMD_RUN_PATH) the built-in flow with a placeholder planner: offline and tests
  capcomd clients add <name> [--scopes read,steer,approve,configure] | list | revoke <id>   harness.v1 API tokens (shown once; steer: start, pause/resume/cancel runs, messages; configure: change settings, set up projects)
  capcomd clients pair --app <name> [--scopes …] [--json]   a token for an app on this computer, printed alone on stdout
                                       for the app to keep (the capcomd app runs it to connect; all four scopes unless
                                       --scopes); revokes the token that app paired before
  capcomd run new [--budget 5|usd=5,turns=200,wallSeconds=3600] [--label L] [--goal G] [--key K] [--checks-set name='cmd']… [--reviewer PROFILE] [--target T [--target-from BASE] | --goal-branch G --base B] [--sandbox docker|boxd]  → runId (a scope; plans nothing; sandbox default: the project's, then your user config's)
  capcomd spawn <runId> --task T [--title "2-4 words"] [--profile P] [--set k=v] [--parent agt] [--key K] [--budget usd=…,turns=…,wallSeconds=…] [--contract JSON|file] [--check NAME] [--report] [--continue agt] [--no-start] [--operator]
  capcomd await <runId> <agt…> [--timeout-ms N] [--notices]  ·  capcomd wait-any <runId> <agt…> [--notices]
  capcomd cancel <runId> [agt] [--reason R]     (propagates to all descendants)  ·  capcomd tree <runId>
  capcomd pause <runId> [agt]                   pause agents (and their descendants): each stops with its work kept on its branch
  capcomd resume <runId> [agt]                  run paused agents (and their paused descendants) again now (paused with \`capcomd pause\` or by a provider usage limit)
  capcomd grant <runId> [agt] --budget usd=…,turns=…,wallSeconds=… [--key K]   give a live agent more budget (from its parent's), or raise the run's
  capcomd verify <runId> --ref <agt|branch> [--check NAME | --checks CMD] [--acceptance JSON|file] [--review-profile P] [--target T] [--key K]  → vfy-…
                                       (checks, then the reviewer agent: the run's --reviewer or --review-profile; both must pass)
  capcomd merge <runId> --ref <agt|branch> --require <vfyId> [--target T] [--operator] [--key K]   (only the verified commit lands)
  capcomd check <runId> [<agt|branch>] [--check NAME | --checks CMD] [--key K]  → chk-…  the run's checks on that branch's
                                       commit as it is (default: the run's target), in a sandbox like verify's; merges and
                                       reviews nothing; prints pass/fail and the output (--id chk-… shows a check again)
  ADR-017 sub-agents (agents allowed to spawn get the same verbs in their VM as \`capcomd\` + MCP tools):
  capcomd spawn … [--children.maxChildren=N --children.maxDepth=N --children.maxTotalDescendants=N --children.allowedChildProfiles=a,b --children.budgetShare=F]
                                       (the parent sets the child's fan-out; narrow-only, refused above the ceiling)
  capcomd tree <runId> [--root agt]      subtree with cost/turn rollups and stuck flags
  capcomd tui [runId] [--view live|waterfall|timeline|rollups|events]   the terminal debugger (no runId: the latest run)
  capcomd inspect <runId> <agt> [--tail N]  ·  capcomd logs <runId> <agt> [--tail N] [--follow]  ·  capcomd budget show <runId> [agt]
  capcomd send <runId> <agt> <text> [--from agt] [--skill NAME]…  ·  capcomd token revoke <runId> <jti> [--reason R]
  capcomd title <runId> <agt> <2-4 words>   name an agent's tab (as the driving harness: the agent's own later renames
                                       replace it; a title the user gave in the apps stays until they clear it)
  capcomd skills                         skills send --skill attaches (bundled and ~/.claude/skills): the agent reads each with the message
  capcomd task add <runId> --title T [--data JSON] [--after tsk,…] [--key K]  ·  task list <runId> [--status open|claimed|done]  ·  task show <runId> <tsk>
  capcomd task claim <runId> [tsk] --holder H [--lease-ms N] [--key K]   → {taskId, epoch, leaseUntil}; no id = next free (expired leases are taken over)
  capcomd task renew|release|done <runId> <tsk> --holder H --epoch E [--lease-ms N] [--result JSON] [--key K]   (fenced: a stale epoch is rejected)
  capcomd kv get <runId> <k>  ·  kv put <runId> <k> <json> [--key K]  ·  kv cas <runId> <k> <json> --expect V [--key K]  ·  kv del <runId> <k> [--expect V]  ·  kv list <runId> [--prefix P] [--all]   (values ≤ 64KB; _ keys are run settings, listed with --prefix _)
  capcomd inspect <runId> [--json] [--follow [--since-seq N] [--until TYPE]]   run bundle: status + tree + trace + events
  capcomd events <runId> --follow [--until TYPE] [--timeout-ms N] [--from-start | --since-seq N]   (with --json: one JSON line per event; resume with --since-seq <last seq>)
  capcomd auth login claude|codex        Log in with your Claude/ChatGPT plan in a VM; saves a private auth profile
  capcomd auth status [agent] [--quick]  Verify saved logins   |   capcomd auth logout claude|codex
  capcomd secrets sync                   Store local ANTHROPIC/OPENAI keys as boxd host-bound secrets
  capcomd doctor                         Check agents + credentials inside a snapshot VM
  capcomd mcp                            Serve capcomd's primitives over MCP (stdio), for your agent
  capcomd hermes [status] | hermes add [--approvals elicit|human] [--hermes-entry-per-project] [--yes]
                                       capcomd in Hermes: whether it's set up, or add it now (what
                                       \`capcomd setup agent\` does for Hermes)
  capcomd setup [demo|accounts|project|agent|service]   Guided setup (interactive; --yes for defaults)
        [--yes] [--demo|--skip-demo] [--agents claude,codex] [--auth subscription|apikey] [--repo URL]
        [--mode pr|direct] [--target B] [--check CMD] [--budget USD] [--service|--no-service] [--no-plugin] [--no-store]
        [--org NAME]                   (the boxd org for the key setup creates with your boxd CLI login)
        [--sandbox docker|boxd]        (setup project: where this project's agents run, over your user config's)
        [--env-build|--no-env-build]   (setup project on Docker: build the env image with a warm checkout now, or don't ask)
        [--default-project]            (setup project/agent: make this checkout the default project of capcomd's MCP tools)
        [--no-hermes] [--approvals elicit|human] [--hermes-entry-per-project]
                                       (capcomd in Hermes, when it's installed: one entry for all your projects, this
                                       checkout added to them; who approves merges into protected branches: elicit,
                                       capcomd asks you in Hermes (recommended), or human, capcomd approve)
  capcomd setup check                    What's configured and working (changes nothing)
  capcomd service install|uninstall|status [--port N] [--dry-run] [--no-login]
                                       The engine as a background service (launchd / systemd user unit);
                                       install --no-login starts it now but not at the next login
  capcomd upgrade [--to X.Y.Z] [--dry-run]
                                       Replace this capcomd with the latest release (the installed binary;
                                       npm and Homebrew installs say how to upgrade them)
  capcomd sandbox shell <runId> <agentId>   A shell in the machine an agent runs on (its sandbox: what you change
  capcomd sandbox shell --sandbox docker|boxd --machine <id>   can change its work), or in a machine capcomd left behind
  capcomd plugins list [--json]          The plugins the running daemon has (or would load, when none runs): each
                                       one's state, why it failed, its hooks and seams (GET /v1/plugins)
  capcomd plugins validate [<dir>|<name>] [--conformance] [--json]
                                       Check a plugin's manifest (a directory, or a built-in by name; all
                                       built-ins with neither); --conformance also loads it and runs its
                                       seam's conformance suite against the real backend
  capcomd ui                             Launch the web UI

Options:
  --json        Machine-readable output (schema "${SCHEMA}"); run streams NDJSON
  --detach      With run: start in the background and print {runId}
  -h, --help    Show this help
  --version     Print the version (also: capcomd version)

Exit codes: 0 ok, 1 run failed, 2 usage, 3 not found, 4 engine unreachable
`;

/** `capcomd <command> … --help`: the usage lines of that command (each with the lines indented under it), or null when
 *  the help names no such command (the whole help is shown then). */
export function commandHelp(command: string, help = HELP): string | null {
  const lines = help.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}capcomd (\S+)/.exec(lines[i]!);
    if (!m || m[1] !== command) continue;
    out.push(lines[i]!);
    while (i + 1 < lines.length && /^ {6,}\S/.test(lines[i + 1]!) && !/^ {2}capcomd /.test(lines[i + 1]!)) out.push(lines[++i]!);
  }
  return out.length ? `\nUsage:\n${out.join("\n")}\n\nRun \`capcomd --help\` for every command.\n` : null;
}
