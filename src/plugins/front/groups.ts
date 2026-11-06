// The kernel's CLI groups as built-in front doors (plugin API §17.1, §17.2 step 8): what was src/cli/index.ts's
// `switch`. Each group's commands live in src/cli/groups/<group>.ts. The dispatcher answers serve, plugins, help,
// version and tui itself; front-mcp has `mcp` (./mcp.ts), front-hermes `hermes` (./hermes.ts).
import { kernelGroup } from "./group";

export const FRONT_RUN = kernelGroup({
  name: "front-run",
  description: "The CLI's run commands: start a run, follow it, decide its approvals, cancel or pause it, and read what it recorded (events, trace, logs).",
  load: async () => (await import("../../cli/groups/run")).COMMANDS,
  commands: [
    { name: "run", summary: "Start or resume a run (a planner agent, or the built-in recipe); `run new` makes a scope that plans nothing" },
    { name: "status", summary: "A run's state, its tasks and what waits for approval" },
    { name: "goal", summary: "A goal-branch run's result; `goal done` and `goal keep`" },
    { name: "pr", summary: "Open a pull request from a run's goal branch into its base" },
    { name: "approve", summary: "Approve (or deny) a merge parked for approval" },
    { name: "cancel", summary: "Cancel a run, or an agent and its subtree" },
    { name: "pause", summary: "Pause agents and their descendants, their work kept" },
    { name: "resume", summary: "Run paused agents again now" },
    { name: "events", summary: "A run's lifecycle events, paged or followed" },
    { name: "replay", summary: "The same as events" },
    { name: "trace", summary: "A run's span waterfall" },
    { name: "inspect", summary: "A run's bundle (status, tree, trace, events), or one agent's record and logs" },
    { name: "logs", summary: "An agent's logs, or follow them" },
    { name: "agent-drive", summary: "Drive one agent of a run in this process (the driver's own step)" },
  ],
});

export const FRONT_PRIMITIVES = kernelGroup({
  name: "front-primitives",
  description: "The CLI's primitives (ADR-016): spawn agents and wait for them, verify, check and merge their work, budgets, messages, titles, the task board and kv.",
  load: async () => (await import("../../cli/groups/primitives")).COMMANDS,
  commands: [
    { name: "spawn", summary: "Start an agent on a task in its own sandbox and branch" },
    { name: "await", summary: "Wait for agents to finish" },
    { name: "wait-any", summary: "Wait for the first of some agents to finish" },
    { name: "send", summary: "Message a running agent, optionally with skills" },
    { name: "grant", summary: "Give a live agent (or the run) more budget" },
    { name: "title", summary: "Name an agent's tab" },
    { name: "tree", summary: "A run's agents as a tree, with spend rollups" },
    { name: "budget", summary: "A run's or an agent's budget and spend" },
    { name: "token", summary: "Revoke an in-sandbox token now" },
    { name: "skills", summary: "The skills `send --skill` can attach" },
    { name: "verify", summary: "Run the run's checks and reviewer on an agent's work put on its target" },
    { name: "check", summary: "Run the run's checks on a branch's commit as it is, merging nothing" },
    { name: "merge", summary: "Land exactly the commit a passing verify tested" },
    { name: "task", summary: "The run's task board: leases with epochs" },
    { name: "kv", summary: "The run's versioned key-value blackboard" },
  ],
});

export const FRONT_PROFILES = kernelGroup({
  name: "front-profiles",
  description: "The CLI's agent profiles: list, show, add, change, remove and validate the named profiles agents are spawned with.",
  load: async () => (await import("../../cli/groups/profiles")).COMMANDS,
  commands: [{ name: "agents", summary: "Agent profiles: list, show, add, set, rm, schema, validate" }],
});

export const FRONT_ENV = kernelGroup({
  name: "front-env",
  description: "The CLI's environments and logins: env snapshots, agent logins, sandbox secrets, the doctor, and a shell in a sandbox machine.",
  load: async () => (await import("../../cli/groups/env")).COMMANDS,
  commands: [
    { name: "env", summary: "Build, list and delete env snapshots (agent CLIs and the repository's dependencies)" },
    { name: "secrets", summary: "Store local API keys as host-bound sandbox secrets" },
    { name: "auth", summary: "Log in with your Claude or ChatGPT plan, check and remove logins" },
    { name: "doctor", summary: "Check the agents and credentials in a snapshot machine" },
    { name: "sandbox", summary: "A shell in the machine an agent runs on" },
  ],
});

export const FRONT_SETUP = kernelGroup({
  name: "front-setup",
  description: "The CLI's setup: guided setup and its check, the engine's background service, upgrades, harness.v1 API clients and the web UI.",
  load: async () => (await import("../../cli/groups/setup")).COMMANDS,
  commands: [
    { name: "setup", summary: "Guided setup (accounts, project, agent, service), or check what's configured" },
    { name: "service", summary: "The engine as a background service: install, uninstall, status" },
    { name: "upgrade", summary: "Replace this capcomd with the latest release" },
    { name: "clients", summary: "harness.v1 API tokens: add, pair an app, list, revoke" },
    { name: "ui", summary: "Launch the web UI" },
  ],
});

export const FRONT_GROUPS = [FRONT_RUN, FRONT_PRIMITIVES, FRONT_PROFILES, FRONT_ENV, FRONT_SETUP];
