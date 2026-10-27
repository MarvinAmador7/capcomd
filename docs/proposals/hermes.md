# Proposal: capcomd × Hermes, beyond MCP and skills

Status: **draft** (not an ADR). Builds on the base integration (`capcomd setup agent` registers `capcomd mcp` in
Hermes and installs the skills; [integration-agents.md#hermes](../integration-agents.md#hermes)).

Everything about Hermes below was checked in [NousResearch/hermes-agent] at commit
[`e5ea5fd`][src] (main, 2026-10-27; the repo's `pyproject.toml` says `0.0.0`, so the commit is the version). Links
point at that commit. Hermes changes fast: recheck before building on a detail.

[NousResearch/hermes-agent]: https://github.com/NousResearch/hermes-agent
[src]: https://github.com/NousResearch/hermes-agent/tree/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6
[d]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs

## 1. What Hermes offers an external tool

| Feature | What it is / how it's configured | How an external tool plugs in |
|---|---|---|
| **MCP client** ([mcp.md][d-mcp], [reference][d-mcpref]) | `mcp_servers.<name>` in `<home>/config.yaml`: stdio (`command`, `args`, `env`, `cwd`) or HTTP. Tools register as `mcp__<server>__<tool>` (`tools/mcp_tool_schema.py`). A stdio server gets a filtered env (PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR, XDG_*) plus its own `env`. A running gateway reloads `mcp_servers` edits within about a minute | Done: the base integration |
| **Trust tiers** | `trust: untrusted` on a server: Hermes asks the user (Once / Session / Always) before every tool without `readOnlyHint`; "Always" goes to `command_allowlist` as `mcp:<server>/<tool>`. `/yolo`, `--yolo`, `approvals.mode: off` skip it. Hermes ignores `destructiveHint` | Done: capcomd's non-destructive write tools are allowlisted, so Hermes asks before merge, cancel and approve |
| **Elicitation** ([mcp.md][d-mcp] § Elicitation) | A server's `elicitation/create` (form mode) goes to the same approval surface: terminal prompt, or buttons in Telegram, Slack…. Only Allow Once / Deny. **YOLO and `approvals.mode: off` don't answer it.** Timeout 300 s. Accept carries empty content (`tools/mcp_tool_sampling.py` `ElicitationHandler`) | capcomd's MCP server can ask the human directly, through whatever surface the chat is on (P1) |
| **MCP events** (experimental) | `events: true` on a server: Hermes subscribes via `events/*`; the server POSTs events to the gateway's webhook listener, each starts an agent run. Needs a public HTTPS `platforms.webhook.extra.public_url` | Push from capcomd (P2, later variant) |
| **Webhooks** ([webhooks.md][d-wh]) | `platforms.webhook.extra.routes.<name>`: HMAC-SHA256-signed POSTs on port 8644; a prompt template; `deliver` to a platform (Telegram…), `deliver_only: true` (no LLM, the template is the message), `mirror_to_session` (a reply in that chat continues with context), `coalesce`, idempotency by `X-Request-ID`, `cron_job` to fire a job | Push run updates into the user's chat (P2) |
| **Messaging gateway** ([messaging/][d-msg]) | `hermes gateway run|install`: Telegram, Discord, Slack, WhatsApp, Signal, Matrix, email, SMS and ~25 more. Approval prompts become native buttons | The surface for P1/P2; nothing to build on our side |
| **Cron** ([cron.md][d-cron]) | `cronjob_manage` tool / `hermes cron`: natural-language or cron schedules, skills attached, `deliver` to a chat; a **no-agent mode** runs a script and delivers its stdout verbatim. Unattended: approval prompts are denied (`approvals.cron_mode: deny`) | Scheduled runs and digests (P3) |
| **Heartbeat / goals** ([heartbeat.md][d-hb], [goals.md][d-goal]) | `/heartbeat every 10m <prompt>` re-enters an idle session; `/goal` keeps working until a judge says done | Live-ish narration of a run with zero code (P3) |
| **Profiles / Bot Mode** ([profiles.md][d-prof], [bot-mode.md][d-bot]) | A profile is a separate home (`~/.hermes/profiles/<name>/`: config, `.env`, `SOUL.md`, memory, skills, cron); `hermes -p <name>`, `hermes profile use`. Bot Mode (desktop app) shows profiles as a roster with avatars, routines, group chats and bot-to-bot messages | capcomd's team as bots (P5) |
| **Personality** ([personality.md][d-pers]) | `SOUL.md` (identity, slot 1 of the prompt), `/personality` overlays | Persona per bot (P5) |
| **Skills + self-improvement** ([skills.md][d-sk], [curator.md][d-cur]) | Agent Skills format under `<home>/skills/**/SKILL.md`; `skill_manage` lets the agent write and patch skills; a background review creates skills from experience; the curator archives only skills it manages (`created_by: agent`) | Done: our skills; learning from runs (P6) |
| **Memory** ([memory.md][d-mem]) | `MEMORY.md` / `USER.md`, frozen into the prompt per session | Hermes remembers the user's repos and preferences; nothing needed from us |
| **Delegation** ([delegation.md][d-del]) | `delegate_task`: in-process child agents with the parent's tools | Overlaps capcomd's spawn. The skill should say: code changes go through capcomd (VMs, verify, merge) |
| **Kanban** ([kanban.md][d-kb]) | A SQLite board shared by profiles; workers are profiles | Overlaps capcomd's task board; no integration proposed |
| **Portable plugins** ([plugins][d-plug]) | Agent Plugins v1 packages: `plugin.json` + `skills/` + root `mcp.json`, `hermes plugins install owner/repo`, disabled until enabled; a package can request `trust: untrusted` for its server | Another way to ship capcomd to Hermes (P4) |
| **ACP server / API server** ([acp.md][d-acp], [api-server.md][d-api]) | Hermes as an ACP agent over stdio (chat, tool activity, diffs, approvals, streamed chunks); an OpenAI-compatible HTTP API with `/v1/runs` and approvals | Hermes as a worker inside capcomd's VMs (P7) |
| **Model providers** | Many (OpenRouter, Nous Portal, Anthropic, OpenAI, local…), credential pools, fallbacks | What P7 would bring: agents on models Claude Code and Codex don't run |

## 2. Proposals

capcomd pieces they rely on: the MCP server (`src/mcp`), the harness API on the 0600 Unix socket with client tokens
scoped `read` / `steer` / `approve` (`src/api/clients.ts`), `POST /v1/approvals/{id}/decision` (idempotent per
client), durable events (`GET /v1/events`, SSE `GET /v1/streams/{scope}/events`), the `driver` policy in
`.capcomd/config.json`, and bot identities (`packages/bot-avatar`: `botName`, `botSvg` from agent id + role).

Rules that hold for every proposal: verification before merge is never skipped or shortened; merges into protected
branches need a human decision; agent-written text reaches Hermes fenced (`<<<untrusted:…>>>`) and never becomes
instructions, prompts or skills unreviewed; no token with `approve` sits where Hermes's model can read it.

### P1. Approve merges from the chat, asked by capcomd itself (elicitation)

Today's `client-confirmed` trusts Hermes's trust prompt, which `/yolo`, `approvals.mode: off` and an earlier
"Always" answer all skip. Proposed: a third `driver.approvals` value, **`elicit`**. `capcomd_approve` then sends
`elicitation/create` (form mode, empty schema) with capcomd's own text: run, merge id, target, the checks that
passed, the reviewer's verdict (as data, fenced), and the commit. Hermes shows it as a prompt or as Telegram/Slack
buttons; accept → approve, decline/cancel/timeout → no decision (the merge stays parked). A client that didn't
declare the `elicitation` capability gets today's `forbidden` answer.

- Value: the headline use case ("approve the merge from my phone") with a gate the model can't answer or bypass.
- capcomd: MCP SDK 1.32 has `server.elicitInput`; read the client's capabilities at `initialize`; the new policy
  value; `setup agent` offers it for Hermes. The decision records `by: "driver:elicited"`.
- Hermes: nothing (elicitation is on by default; `mcp_servers.capcomd.elicitation.timeout` if 300 s is short).
- Security: strictly stronger than `client-confirmed`. Residual risk: a compromised Hermes process could auto-accept,
  the same trust we give any client UI. Unattended sessions (cron, `chat -q`) decline.
- Effort **S–M**. Depends on nothing beyond the base integration.
- **Decided (owner, 2026-10-27):** `elicit` is the recommended Hermes setting.
- **Lessons from Claude Code's elicitation** (supported since 2.1.76, form and URL modes;
  [MCP docs](https://code.claude.com/docs/en/mcp), [hooks](https://code.claude.com/docs/en/hooks#elicitation),
  [headless](https://code.claude.com/docs/en/headless.md)), so the same gate can serve Claude Code as a driver:
  - Its `Elicitation` hooks can accept with content and no dialog; the server can't tell a hook from a person, and in
    `claude -p` a repo's `.claude/settings.json` hooks run without a trust prompt. Hermes has no such hooks. For Claude
    Code, also mark `capcomd_approve` with `_meta["anthropic/requiresUserInteraction"]: true` (a person answers on
    every call, even in bypass/auto modes) and keep the elicitation on top. Open: whether PreToolUse hooks can clear
    `requiresUserInteraction`; until checked, recommend `elicit` to Claude Code users only with managed hooks
    (`allowManagedHooksOnly`).
  - Fail closed: no `form` elicitation capability at `initialize` means no approval through MCP; decline, cancel and
    no answer leave the merge parked; the tool result says "no decision; do not retry".
  - Bind and check: the prompt names repo, target and exact commit; require an explicit accept of that commit (not
    just non-empty content); the merge re-checks the branch hasn't moved. Never mark the approve tool `idempotentHint`
    (Claude Code may replay idempotent calls).
  - Never ask for secrets in form mode (URL mode or the terminal only).

### P1b. One Hermes entry for all projects (decided, 2026-10-27)

Replace the base integration's one-folder `cwd` with a project argument: a single `mcp_servers.capcomd` entry with no
pinned `cwd`; `capcomd setup agent` in a repo adds it to capcomd's project list instead of moving the entry; tools take
an optional `project` (default: the configured default, or the only project); a `capcomd_projects` tool lists them;
#1's prompt and #2's messages always name the project. Not one entry per project: every tool would be listed once per
project (tool-list bloat), the allowlist/ask rules would be repeated per entry, and from chat there's no working folder
to choose a server by. An opt-in `setup agent` flag can still write a separate entry (e.g. different trust per repo).
Effort **S**; build with P1.

### P2. Run updates pushed into the user's chat (Hermes webhooks)

capcomd posts selected events to a Hermes webhook route: a merge awaiting approval, a run finished or failed, an
agent paused on a quota or flagged stuck. Default route `deliver_only: true` (no LLM: the message is rendered from
capcomd's structured fields, so agent text can't steer anything) with `mirror_to_session: true`, so "approve it" in
that chat continues in a session that has the context, and the approval goes through P1.

- Value: the user doesn't poll; Hermes becomes the notification channel without capcomd knowing about Telegram.
- capcomd: an outbound notifier in the daemon: `capcomd notify add hermes --url http://127.0.0.1:8644/webhooks/capcomd
  --events approval,run.end,agent.notice` (secret generated, kept in the state dir), HMAC-SHA256 body signature,
  `X-Request-ID` = event seq (Hermes dedupes), retries with backoff, cursor persisted so restarts don't resend.
  `setup agent` writes the matching route in Hermes's `config.yaml` (same structural editor).
- Hermes: the webhook platform enabled (`hermes gateway` running); route config.
- Security: loopback by default; the HMAC secret is shared with Hermes's config only; payload carries ids and
  capcomd-authored text, never raw agent output unless fenced. No `approve` scope involved.
- **Decided (owner, 2026-10-27):** outbound is fine where it's the best approach: push, off until `setup agent`
  writes the Hermes route, loopback by default, signed.
- Effort **M**. Later variant: implement MCP events (`events/*`) in `capcomd mcp` once the spec settles; it needs a
  public HTTPS URL, so loopback webhooks first.

### P3. Recipes: scheduled runs, digests, narration (no new code)

- Nightly run: a Hermes cron job "Use capcomd to fix flaky tests, land on `capcomd/nightly`, report" with the
  capcomd skills attached, delivered to Telegram. Cron is unattended, so merge/approve prompts are refused: a run
  can verify and stage but never merge into a protected branch by itself. That's the intended behaviour; say it.
- Morning digest: a cron **no-agent** job running `capcomd runs --json | <formatter>`: zero LLM cost.
- Narration: `/heartbeat every 5m Check capcomd run R: tell me what changed, don't repeat yourself`.
- capcomd: docs, one small `capcomd runs --digest` text output (optional). Hermes: nothing.
- Effort **S**. Value: medium, immediately.

### P4. Ship capcomd as a Hermes portable plugin

A package (`plugin.json`, `skills/`, `mcp.json`) installable with `hermes plugins install MarvinAmador7/capcomd`
(a subdirectory or separate repo, to check), requesting `trust: untrusted` for its server through
`extensions["com.nousresearch.hermes"]`. Skills become read-only and namespaced (`capcomd:capcomd-orchestration`),
so Hermes's self-improvement can't drift them.

- capcomd: the package (generated from `plugins/capcomd`), and a launcher under `PLUGIN_ROOT` like
  `plugins/capcomd/mcp/launch.sh` that finds the installed `capcomd` (a package can't know its absolute path) and the
  project directory (`${workspaceFolder}`, to check).
- Open: whether a package's `mcp.json` takes a `cwd`; it can't add `command_allowlist` or `approvals.deny`
  entries, so without them Hermes asks before every capcomd write tool. `setup agent` stays the way to get the full
  setup; the package is the discovery path.
- Effort **S–M**. Value: discoverability.

### P5. capcomd's team as Hermes bots

One Hermes profile per capcomd role the user talks to (planner, reviewer, workers), named and drawn like the menu
bar app's bots (`botName`, `botSvg` from the role, rasterized for Hermes's avatar), with a `SOUL.md` that says what
it can do: read its agents' threads (`capcomd_inspect`, `capcomd_tree`), relay a message (`capcomd_send`), nothing
else (`tools.include` on its `mcp_servers.capcomd`). In Bot Mode's group chat the user talks to "the team".

- Evaluate honestly: capcomd agents live for one run; bots are per role, so a bot speaks for whichever agents of its
  role are running. Each bot is a Hermes agent with its own model bill. Bot Mode is in the desktop app; on Telegram
  it's one bot account per profile.
- **Decided (owner, 2026-10-27):** the target is Hermes's desktop Bot Mode only, for now; Telegram/Slack bots are out of
  scope.
- Later (roadmap, nice to have; owner 2026-10-27): adopt bots the user already has in Hermes for capcomd's roles,
  creating profiles only for unfilled roles: a role → profile map; setup writes the capcomd entry, ask-before-merge
  rules and skills into each chosen profile and leaves its persona, memory and model alone; role-scoped tools; `setup
  check` flags a profile with an "Always" allowlist or approvals off (merges still go through P1); decide whether agent
  thread text may reach an adopted bot's memory/curator (scope out, or opt-in with a warning).
- capcomd: `capcomd hermes bots` to create profiles (Hermes's `hermes profile create` does the dirs; we write
  `SOUL.md`, the MCP entry with a tool filter, the avatar). Hermes: profiles, desktop app for the roster.
- Security: read + steer only; never approve tools.
- Effort **M–L**. Value: delight and a clear mental model; not essential. After P1–P2.

### P6. Hermes learns from capcomd runs

After a run, `capcomd_retro` (or a field on the last `capcomd_await`) returns capcomd-authored facts: the pattern
used, which checks caught what, cost per agent, what was cancelled or continued. Hermes's background review can turn
recurring ones into its own skills ("for this repo, fan out per package; the integration check is slow").

- capcomd: the retro (from events and budgets only). Hermes: nothing; its review decides.
- Security: only capcomd's structured facts; agent text never flows into a skill (a skill is a persistent prompt:
  injected agent text there would outlive the run). Effort **M**. Value: uncertain; measure before investing.

### P7. Hermes as a provider (a worker in the VM)

A third agent kind next to Claude Code and Codex: Hermes installed in the snapshot, driven over ACP (stdio: chat,
tool activity, diffs, streamed chunks) so the runner gets structured output for threads and steps.

- Value: models capcomd can't run today (OpenRouter, Nous Portal, local), best-of-n across vendors.
- capcomd: the adapter (ACP → thread items), installer and snapshot, credentials as boxd secrets, the supervisor,
  turn/cost accounting from ACP, a run in the isolated VM with Hermes's approvals off (the VM is the boundary).
- Effort **L**. After P1–P3; needs a stable ACP surface.

### Rejected / not now

- **Kanban ↔ task board**: two boards with different semantics (leases and epochs vs. profile workers); syncing
  them adds failure modes for little gain.
- **Hermes holding a harness token with `approve`**: Hermes's terminal tool runs as the same user and can read
  its `.env`; that token would let the model approve. Approvals go through P1 instead.

## 3. Ranking and first slice

| # | Proposal | Value | Effort | Depends on |
|---|---|---|---|---|
| 1 | P1 elicitation approvals | High | S–M | base |
| 2 | P2 pushed updates (webhooks) | High | M | base; pairs with P1 |
| 3 | P3 cron / digest / heartbeat recipes | Medium | S | base |
| 4 | P4 portable plugin | Medium | S–M | — |
| 5 | P5 team as bots | Medium | M–L | P1, P2 |
| 6 | P6 learn from runs | Unclear | M | — |
| 7 | P7 Hermes as provider | High, later | L | ACP adapter |

**First slice (one PR after the base): P1.** `driver.approvals: "elicit"`, `capcomd_approve` asking through
`elicitation/create`, the client-capability check, `setup agent` offering it for Hermes, tests with a scripted MCP
client that accepts / declines / times out, and the P3 recipes in the Hermes docs. It turns "approve from Telegram"
into something safe to recommend, and P2 then only has to deliver the nudge.

## 4. Open questions for the owner

1. ~~Is `elicit` acceptable as the *recommended* Hermes setting~~ Yes (2026-10-27). (the human answers a capcomd-authored prompt in their
   chat), or must protected merges stay terminal-only (`capcomd approve`)?
2. ~~P2: is a daemon-side outbound notifier~~ Yes, where it's the best approach (2026-10-27). (HTTP POSTs from capcomd, loopback by default) in scope, or should
   notifications stay pull-only (MCP, SSE)?
3. ~~P5: is the desktop-app Bot Mode a target, or is Telegram/Slack the surface that matters?~~ Bot Mode only, for now (2026-10-27).
4. P7: is a third provider (and the model bills it brings) wanted at all, or is capcomd Claude Code + Codex only?
5. Should capcomd publish a Hermes portable plugin (P4) from this repo, or keep `capcomd setup agent` as the only path?

[d-mcp]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/mcp.md
[d-mcpref]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/reference/mcp-config-reference.md
[d-wh]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/messaging/webhooks.md
[d-msg]: https://github.com/NousResearch/hermes-agent/tree/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/messaging
[d-cron]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/cron.md
[d-hb]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/heartbeat.md
[d-goal]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/goals.md
[d-prof]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/profiles.md
[d-bot]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/bot-mode.md
[d-pers]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/personality.md
[d-sk]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/skills.md
[d-cur]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/curator.md
[d-mem]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/memory.md
[d-del]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/delegation.md
[d-kb]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/kanban.md
[d-plug]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/developer-guide/plugins/index.md
[d-acp]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/acp.md
[d-api]: https://github.com/NousResearch/hermes-agent/blob/e5ea5fd9ccdf2913c0b21b24eb3d22b321d2e2a6/website/docs/user-guide/features/api-server.md
