# Writing capcomd plugins

A capcomd plugin hears what happens to your runs (a run started or ended, an agent failed or needs attention, work
landed), can judge what capcomd is about to do (allow or deny a merge, a verification, an approval, a trigger), and can
say things on a run's stream. It is how you connect capcomd to the rest of your tools: a Slack or pager notifier, a
policy gate on merges, a scanner that judges a verification, a dashboard feed.

This guide is for plugin authors. The normative reference is the plugin API spec,
[docs/spec/plugin-api.md](spec/plugin-api.md) (cited as §n below); the types are the
[`@capcomd/plugin`](../packages/plugin) package; worked examples are in
[packages/plugin/examples](../packages/plugin/examples).

> **The package.** `@capcomd/plugin` is published to npm by capcomd's release workflow at capcomd's own version, once
> that is switched on; until it is on npm, build it from a capcomd checkout (`bun packages/plugin/scripts/pack.ts`
> writes `packages/plugin/dist/capcomd-plugin-X.Y.Z.tgz`) and `npm install` that file.

> "Plugin" here means a plugin **for** capcomd. [`plugins/capcomd`](../plugins/capcomd) is the other way round: capcomd
> as a plugin for Claude Code and Codex.

## How a plugin runs

Your plugin is a **program**. The capcomd daemon starts it, hands it a token and a socket, and supervises it: it is
restarted if it exits, and stopped with the daemon. It talks to the daemon over the same HTTP API every capcomd client
uses (harness.v1), on a socket only plugins can use:

1. It opens a **session** (the handshake): the daemon checks it was started from the files it loaded and answers with
   the plugin's settings and secrets.
2. It reads its **hooks stream**: one frame per hook call, in order.
3. It **answers** gate calls (allow or deny) before their deadline; other calls need no answer.
4. It may **emit** its own events, keep **storage**, and call the read and steer parts of the API with its token.

capcomd's own plugins (the sandboxes, agent providers, forges, the reviewer gate, the watchdog) run inside the daemon
and can do more (provide a sandbox, a forge, a CLI command). A third-party plugin always runs as its own process, with
only what its manifest asks for (§5.2, §11).

## A first plugin

A directory with a manifest and a program:

```
my-gate/
  plugin.json
  index.ts
```

`plugin.json` (§4; the JSON Schema is `@capcomd/plugin/schema`):

```json
{
  "schema": "capcomd.plugin/v1",
  "name": "my-gate",
  "version": "1.0.0",
  "description": "Refuses merges into main on Fridays.",
  "apiVersion": 1,
  "engines": { "capcomd": ">=0.9.0 <1.0.0" },
  "entry": { "runtime": "process", "command": ["node", "${PLUGIN_ROOT}/dist/index.js"] },
  "scopes": ["read"],
  "contributes": { "hooks": { "merge.landing": {} } }
}
```

`index.ts`:

```ts
import { connect, sessionOpen } from "@capcomd/plugin";

const client = connect();                         // the socket and token the daemon gave this process
await client.open(sessionOpen());                 // the handshake: session, manifest hash, declared hooks
for await (const frame of client.hooks(new AbortController().signal)) {
  if (frame.frame !== "hook.call" || frame.call.hook !== "merge.landing") continue;
  const { target } = frame.call.payload as { target: { branch: string } };
  const friday = new Date().getDay() === 5;
  await client.answer(frame.call.callId, {
    session: client.session,
    result: friday && target.branch === "main" ? { decision: "deny", reason: "No merges into main on Fridays." } : { decision: "allow" },
  });
}
// The stream ends when the daemon stops this plugin (session.closing) or goes away (stdin closes).
process.exit(0);
```

Build it into the one file the manifest runs (why: [Shipping](#shipping-a-plugin)), check the manifest, then put the
plugin where the daemon looks and restart the daemon:

```sh
npm install @capcomd/plugin
bun build index.ts --target=node --outfile dist/index.js
capcomd plugins validate ./my-gate        # the checks the daemon runs (§4.9)
cp -R ./my-gate ~/.capcomd/plugins/my-gate
capcomd plugins list                      # my-gate: process, user, active
```

From a git repository, `capcomd plugins install` does the copying for you (see [Shipping](#shipping-a-plugin)).

## The manifest

| Field | What it is |
|---|---|
| `schema` | Always `"capcomd.plugin/v1"`. |
| `name` | `^[a-z0-9][a-z0-9-]{0,62}$`; your events are `plugin.<name>.<event>`, your settings `plugins.<name>`. Not a built-in's name. |
| `version` | Your plugin's own semver. |
| `description` | One sentence, shown by `capcomd plugins list` and the app. |
| `apiVersion` | `1`. |
| `engines.capcomd` | The capcomd versions you tested with (`>=0.9.0 <1.0.0`; `*` is refused). A daemon outside the range doesn't run the plugin; `capcomd plugins allow-version <name>@<version> --accept-risk` lets one version through. |
| `entry` | `{ "runtime": "process", "command": [...], "env": {...} }`. `${PLUGIN_ROOT}` is the plugin's directory, `${PLUGIN_DATA}` a directory of its own for data. A path in `command[0]` starting with `./` must stay inside the directory, and so must every path the command and `entry.env`'s `NODE_PATH`, `NODE_OPTIONS` and `BUN_OPTIONS` name ([self-contained](#shipping-a-plugin)). |
| `scopes` | What the plugin's own token may do (§11.1): `read` (runs, agents, events, profiles), `steer` (start, pause, cancel runs, send messages, emit events), `configure`. `approve` is never grantable: approvals stay human. Default: none, which is enough to answer hooks. |
| `order`, `after` | Where your listeners run among other plugins' (`pre`, `normal`, `post`; §6.3). |
| `contributes.hooks` | The hooks you answer: `{ "merge.landing": { "timeoutMs": 5000 } }` (a lower deadline than the default is allowed, a higher one than the maximum is refused). On `job.changed`, `changes` names the change kinds you want: `{ "job.changed": { "changes": ["fired"] } }` for a plugin that only keeps a timer, so capcomd doesn't read every running job's output for you (`started`, `output`, `fired`, `ended`; default all). |
| `contributes.events` | Names of your own events (`posted` → `plugin.my-gate.posted`). |
| `config` | A JSON Schema for your settings (below). |
| `homepage`, `license` | Shown, not checked. |

A third-party plugin contributes hooks and events only: sandboxes, agent providers, forges, trigger sources, CLI
commands, MCP tools, API routes and UI need a plugin inside the daemon, which only capcomd's own can be today (§9.6).

## Hooks

Every hook has a **mode** and a deadline (§6). Your process gets each call as a `hook.call` frame whose `call` carries
the hook's name, its `mode`, a `deadline` (an absolute time on the daemon's clock), an `idempotencyKey`, who caused it
(`principal`), the run and agent, and the `payload` (`HookPayload<"merge.landing">` in the package's types).

| Mode | Hooks | What you send back |
|---|---|---|
| observe | `daemon.started`, `daemon.stopping`, `run.changed`, `agent.changed`, `agent.item`, `sandbox.changed`, `verify.changed`, `merge.changed`, `approval.changed`, `job.changed`, `trigger.changed` | nothing |
| veto (a gate) | `verify.judging`, `merge.landing` (also `hold`: ask a person), `approval.deciding`, `trigger.admitting` | `{decision: "allow"}` or `{decision: "deny", reason}` |
| modify | `run.creating`, `profile.resolved`, `agent.spawning`, `agent.preparing`, `sandbox.ensuring`, `verify.starting` | `{decision: "allow", patch?}` or a deny; a patch may only narrow (§6.6) |

What to know when you answer:

- **Gates fail closed.** A gate call you don't answer in time, answer wrongly, or that is in flight when your process
  dies is a **deny**. Three failed calls in a row suspend your listeners, and a suspended gate keeps denying until
  someone looks (`capcomd plugins enable <name>`, or a daemon restart). Other hooks fail open: your listener is
  skipped. Answer at least a second before the deadline.
- **Calls come one at a time** for gates and modifies (the next after you answered the previous); observe calls arrive
  as they happen. If you can't keep up with observe calls, the oldest are dropped and a `hook.dropped` frame says how
  many.
- **Calls can repeat.** After a crash or a restart capcomd may ask again; `idempotencyKey` is the same for the same
  question, so key your side effects on it.
- **Payload text written by agents is untrusted** (tasks, summaries, reasons: fields marked `untrusted`). Quote it as
  plain text; never let it become markup, a link, a mention or a command.
- An operator can merge past your veto (`capcomd merge --operator`): the merge is recorded with your plugin's reason as
  bypassed (§6.5).
- **You hear what the daemon runs** (§6.1). Merges, the `*.changed` hooks, sandboxes, triggers and everything an agent
  asks for from its sandbox run in the daemon. An operation `capcomd` or its MCP server runs in its own process
  (`capcomd verify`, `spawn`, `approve`, `run new` from your shell, or the driver's MCP tools) fires its gates there,
  where your plugin doesn't run: `verify.judging`, `verify.starting`, `approval.deciding`, `run.creating`,
  `agent.spawning` and the other spawn hooks don't reach you for those yet. `merge.landing` always does.

Deadlines (§6.4): observe 30 s (`agent.item`, `job.changed` 5 s), gates and modifies 10 s (at most 60 s),
`verify.judging` 30 min (at most 60: a reviewer agent runs inside it).

## What the process can do

`connect()` (from `@capcomd/plugin` or `@capcomd/plugin/client`) returns a `PluginClient` (§9.8):

| Method | What it does |
|---|---|
| `open(sessionOpen())` | The handshake (§9.3). Answers `{config, secrets, hookTimeoutsMs, daemon}`. |
| `hooks(signal)` | The hooks stream: reconnects and resumes where it left off; ends on `session.closing`, your signal, or when the daemon goes away. |
| `answer(callId, {session, result})` | Answers a gate or modify call; retried until the call's deadline while the daemon can't be reached; a refusal (the call was already settled, or your answer was invalid) is final. |
| `emit({type, stream, entity, text, data})` | Writes `plugin.<name>.<type>` on a run's stream (`stream` is the run id) or `daemon`. Needs `steer` and the event declared in `contributes.events`. |
| `storage.get/put/delete/list(key, …, run?)` | Your own small JSON store (values up to 64 KB), for the daemon or per run; `put` with `expect` is a compare-and-swap. |
| `fetch(path, init)` | Any other harness.v1 route with your token: `GET /v1/runs`, `/v1/runs/{id}/agents`, `/v1/events`, `POST /v1/runs/{id}/cancel`, … as your scopes allow (§9.6). |

The process gets only this environment (§9.2): `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, your manifest's
`entry.env`, and `CAPCOMD_PLUGIN_NAME`, `CAPCOMD_PLUGIN_ROOT`, `CAPCOMD_PLUGIN_DATA`, `CAPCOMD_PLUGIN_SOCKET`,
`CAPCOMD_PLUGIN_SESSION`, `CAPCOMD_PLUGIN_TOKEN`, `CAPCOMD_PLUGIN_PROTOCOL`. Nothing else of the daemon's reaches it: no
`GITHUB_TOKEN`, no sandbox keys. Its token is new at every start, lives only in the daemon's memory, and is revoked when
the process is gone.

**Lifecycle.** The process runs in its own process group: when it exits, whatever it started that still runs there is
killed. It should exit when the hooks stream ends, and when its stdin closes (the daemon is gone; `connect()` ends the
stream then). A process that exits is started again after 1 s,
2 s, 4 s … 60 s, with a new session and token; five exits within 10 minutes stop that (`failed (restart_limit)`), and
its gates deny until it is enabled again. When the daemon stops it, it sends `session.closing`, then SIGTERM 5 s later,
then SIGKILL.

**Logs.** Whatever the process writes to stdout and stderr is the plugin's log in the daemon's (`~/.capcomd/engine.log`
for the service): a line that is JSON with a `level` field is logged as such, any other line at `info`. Your token and
your secrets' values are redacted from it.

## Settings and secrets

`config` in the manifest is a JSON Schema for the object at `plugins.<name>` (§10). Make it an object with
`additionalProperties: false`; defaults are applied first. Two marks:

- `"x-secret": true`: the value is a **reference**, never the secret itself: `{"$secret": "env:SLACK_WEBHOOK"}` (an
  environment variable of the daemon). Your process gets the resolved value once, in the handshake's `secrets`, never
  in its environment or arguments. The user sets the reference (below): a `default` reference in your schema is not
  followed, since a plugin doesn't choose which of the user's variables it receives. Until it is set, the secret is
  missing from `secrets`; say what to set. A reference may not name one of capcomd's own variables (`BOXD_API_KEY`,
  `GITHUB_TOKEN`, `GH_TOKEN`, `CAPCOMD_*`, `RELAY_*`, `GIT_*`, `RIVET*`, `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`,
  `CODEX_*`, in any case) or its keychain items (`keychain:capcomd…`), as your default or in the user's config: the
  plugin fails `config_invalid` instead (§10.3). Suggest a variable of your own (`env:MY_PLUGIN_GITHUB_TOKEN`);
  `capcomd plugins validate` flags a default that names one of capcomd's.
- `"x-per-run": true`: a run may set it (`capcomd run --plugin-config my-gate.strict=true`, or `plugins` in
  `POST /v1/runs`).

Users set them in `~/.capcomd/config.json`:

```json
{ "plugins": { "slack-notifier": { "webhook": { "$secret": "env:SLACK_WEBHOOK" }, "channel": "#builds" } } }
```

or in the environment, one variable per setting: `CAPCOMD_PLUGIN_SLACK_NOTIFIER_CHANNEL=#builds` (a value that reads as
JSON is that value, else a string; a secret's is its reference, `'{"$secret": "env:SLACK_WEBHOOK"}'`). A
project's `.capcomd/config.json` may adjust settings, but can neither turn a plugin on nor point a secret elsewhere
(§10.2). `enabled: false` keeps a plugin from running: `capcomd plugins disable <name>` sets it in your config and
stops the plugin in the running daemon, `capcomd plugins enable <name>` turns it back on (and resets a suspended gate).

## Testing

The test kit is `@capcomd/plugin/testkit` (§14.5). For a plugin process, three layers work well; the Slack example has
all three ([packages/plugin/examples/slack-notifier](../packages/plugin/examples/slack-notifier)):

**Your decisions, as plain functions.** Build calls with `testkit.call(hook, samplePayload(hook))` (a payload of the
right shape) and test what your plugin decides for each:

```ts
import { samplePayload, testkit } from "@capcomd/plugin/testkit";
const call = testkit.call("merge.landing", samplePayload("merge.landing"));
expect(decide(call)).toEqual({ decision: "allow" });
```

**Your main loop, against a stand-in client.** `PluginClient` is an interface: give your loop one that plays frames
and records what it sent, and check the handshake, the answers and the events without a daemon.

**The real thing.** `testkit.bootWith` boots a capcomd daemon in a home of its own, on the fake sandbox with scripted
agents (no VMs, no models, no accounts), with your plugin directories installed as the user's; waits until each is
`active`; runs your test; stops it and removes the home:

```ts
import { testkit } from "@capcomd/plugin/testkit";

await testkit.bootWith([{ dir: "." }], async (d) => {
  const run = (await d.cli(["run", "new", "--budget", "usd=1", "--json"])).json.runId;
  await d.cli(["spawn", run, "--profile", "worker", "--task", "fail please", "--contract", JSON.stringify({ script: "exit 1" }), "--json"]);
  // … assert what your plugin did: a webhook it called, its events in GET /v1/events?scope=<run> (d.fetch) …
}, {
  config: { "my-plugin": { webhook: { $secret: "env:HOOK_URL" } } },
  env: { HOOK_URL: "http://127.0.0.1:8080/hook" },
});
```

`bootWith` runs the `capcomd` on your `PATH` (or `CAPCOMD_TESTKIT_BIN`, or the `capcomd` option: an argv prefix). A
scripted agent with no contract script finishes at once; `{"script": "exit 1"}` fails it; the profiles `planner`,
`worker` and `reviewer` exist (or bring your own with `profiles`). `d.fetch` calls the API with an operator's token,
`d.cli` runs the CLI against this daemon, `d.log()` is the daemon's log. Nothing of your own capcomd setup is read or
touched.

capcomd's own tests run the examples this way: the in-process ones through `loadDispose` and `hookContract`
(`tests/plugins/host.test.ts`), the Slack example's unit tests (`bun test packages/plugin`), and the Slack example
against a real daemon (`tests/scenarios/plugin-slack-example.test.ts`).

## Shipping a plugin

A plugin is a directory in a git repository: at the root (`plugin.json` there) or one of several (`plugins/my-gate/`).
Users install it with:

```sh
capcomd plugins install acme/capcomd-my-gate            # GitHub owner/repo; a git URL or a local repository works too
capcomd plugins install acme/plugins#my-gate@v1.2.0     # one plugin of several, at a tag (or branch, or commit)
capcomd plugins update my-gate [--dry-run]              # shows what changed before replacing it
capcomd plugins remove my-gate
```

Install writes your files **out of the commit**: no checkout, no install scripts, no submodules, no links that leave the
directory (at most 5 000 files, 100 MB). So **commit what runs**: bundle your program and its dependencies into one file
and point `entry.command` at it:

```sh
bun build index.ts --target=node --outfile dist/index.js     # or esbuild, tsup, …
```

with `"command": ["node", "${PLUGIN_ROOT}/dist/index.js"]` (or `bun`). `@capcomd/plugin` runs on Node ≥ 20 and Bun.
The plugin lands in `~/.capcomd/plugins/<name>/` with a `LOCK` file (where it came from, the commit, every file's
hash); the daemon starts it at its next start.

**Keep it self-contained.** Everything your plugin runs must be inside its own directory: the `LOCK` and a project's
trust cover that directory, so code from anywhere else could change without anyone being asked again (§4.9). capcomd
refuses, at `install`, `update`, `trust` and `validate`, and again before every start, a plugin whose entry or any
module it imports lies outside its directory: `../lib`, a `node_modules` above it, a link that points out, its data
directory. What is fine: its own files and its own `node_modules` (`@capcomd/plugin` installed there, or bundled),
`node:` and Bun's built-ins. A copy of `@capcomd/plugin` above the directory is outside like anything else (only
capcomd's own copy, when it runs from a checkout, is allowed from outside). Name the runtime by its name (`bun`,
`node`), not its path.
`capcomd plugins validate <dir>` lists each import that reaches out, with the file that makes it and where it leads:

```text
✗ my-gate 1.0.0 (./my-gate)
    ✗ index.ts: ../shared/format resolves outside the plugin's folder: /Users/me/acme/shared/format.ts
```

Bundling (above) is the easy way to be self-contained. While it runs, a Bun or Node process also has a guard that
refuses a module from outside the directory as it loads, in its workers too (so an import whose path is computed at run
time is held too);
what a shell script or another runtime loads isn't checked, so keep those inside as well.

**Project plugins.** A repository can bring its own plugins (`.capcomd/plugins/<name>/`, or `plugins.use` in its
`.capcomd/config.json`, fetched with `capcomd plugins install --project`). Opening a repository must never run code on
your machine, so a project's plugin runs only after you trust its exact content once: `capcomd plugins trust <name>`
shows what would run (the command, its scopes, its hooks, the secrets it would get) and asks. A changed file needs
trusting again.

## Good manners

capcomd is meant to be quiet (§16.5). A notifier should speak on failures, on what needs a person, and on landed work,
and offer a `quiet` setting (`x-per-run`) for the rest. A gate should explain a deny in one sentence a person can act on.
Keep secrets in `x-secret` settings, never in `entry.env` or the manifest.

## Versions

`apiVersion` is the plugin API's major (1). `engines.capcomd` is what you tested. `@capcomd/plugin` is versioned with
capcomd: `@capcomd/plugin@0.9.0` is the API of capcomd 0.9.0. The process protocol is version 1 (`sessionOpen()` says
so); a new optional field, frame or route is not a new version, so ignore what you don't know (§9.10). The handshake's
`SessionOpened.daemon` has the daemon's version and capabilities, for feature detection.

## Examples

| Example | Shows |
|---|---|
| [slack-notifier](../packages/plugin/examples/slack-notifier) | A third-party plugin: a process, observe hooks, a secret webhook, its own event, and its tests (unit, stand-in client, `bootWith`). |
| [gate-reviewer](../packages/plugin/examples/gate-reviewer) | A `verify.judging` gate that runs a reviewer agent (in process, as capcomd's own reviewer is). |
| [watchdog](../packages/plugin/examples/watchdog) | Observe hooks and a timer that stops stalled agents (in process, as capcomd's own watchdog is). |
| [sandbox-docker](../packages/plugin/examples/sandbox-docker), [forge-github](../packages/plugin/examples/forge-github) | Seams: a sandbox provider and a forge (in process). |

The in-process examples show how capcomd's own plugins are built; a plugin of yours runs as a process, like the Slack
one. The examples run from a capcomd checkout, where they import the package from it; to ship one, bundle it as
[Shipping](#shipping-a-plugin) says.
