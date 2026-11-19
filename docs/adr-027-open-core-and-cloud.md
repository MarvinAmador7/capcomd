# ADR-027: What's open source and what's capcomd cloud

**Status:** accepted (owner, 2026-11-19). Builds on ADR-023 (everything is a plugin), ADR-021 (sandbox providers),
ADR-026 (durable agents and threads). The license stays MIT; changing it is a separate decision for the maintainer
(AGENTS.md).

## Context

capcomd ships three things: **capcomd core** (the engine: daemon, CLI, MCP, plugins), **capcomd desktop** (the Mac
app, bring your own keys and logins) and, later, **capcomd cloud** (a hosted service for people and teams, with an iOS
client). The owner's direction: "the local open-source version, but also the cloud paid version", as Conductor does.

Without a written line, every feature invites the same question ("does this go in core or in cloud?"), and the usual
failure of open-source-plus-hosted projects follows: the open version is quietly held back to make the hosted one look
better, and its users stop trusting it.

## Decision

### The rule

**Open source is everything one person can run on their own machine with their own accounts. capcomd cloud is what a
laptop can't do: run when it's closed, be reached from anywhere, hold shared state for a team, and manage
infrastructure and secrets on the user's behalf.**

A feature that works locally is never removed from, limited in, or made worse in the open version to make cloud look
better. Cloud adds; it doesn't take away.

### Open source (this repository, MIT)

- The engine: daemon, CLI, MCP server, harness.v1 API, the plugin kernel and its seams, every built-in plugin.
- Orchestration: planners, leads, workers, reviewers, verify and the merge gate, goal branches, approvals, budgets.
- Durable agents (ADR-026): durable threads, saved CLI sessions, waking, hibernation, ask and stop.
- Places agents run: local Docker, boxd with the user's own key, and any provider plugin anyone writes.
- Session stores the user owns: iCloud Drive, S3-compatible storage (S3, R2, MinIO, a Vercel Marketplace bucket),
  Vercel Blob with the user's own token.
- The desktop app and the menu bar app.
- The protocol and contracts (harness.v1, the plugin API, the event and thread formats), so third-party clients and
  plugins work against both.

### capcomd cloud (a separate, private service)

- **Always on:** a hosted engine, so runs continue with the laptop closed.
- **Managed machines:** capcomd provides the VMs; no sandbox provider account or setup.
- **Anywhere:** the iOS app and web access to the same runs, approvals and threads.
- **Teams:** shared projects and runs, roles, approvals by teammates, SSO, audit log.
- **Managed secrets and integrations:** secrets held per tenant with host-bound substitution; hosted GitHub, Slack
  and similar integrations.
- **Included storage and sync** for sessions and settings across devices and teammates.

### How cloud is built

- Cloud runs the open engine. Its own parts are plugins and services against the engine's public seams (sandbox,
  session store, sync, identity and principals, secrets, triggers), kept in a private repository.
- No hidden "cloud mode" in core: no `if cloud` branches, no features compiled out of the open build. A seam cloud
  needs is designed and documented in the open, with an open implementation where one makes sense locally.
- Contracts are shared: a client or plugin built against harness.v1 works with a local engine and with cloud.

### Deciding a new feature

1. Does it need infrastructure capcomd operates for the user (always-on hosting, managed VMs, tenant secrets,
   cross-device or cross-person state)? → **cloud** (and the seam it plugs into is **open**).
2. Can one person run it on their own machine with their own accounts? → **open**, complete, not a teaser.
3. Unsure → open. Moving something from open to cloud later breaks trust; moving it the other way doesn't.

## Consequences

- The open engine has to keep clean seams for everything cloud does, which is also what third-party plugins need.
- Some features have two homes: an open, self-hosted form (iCloud or your own bucket) and a managed one (cloud
  storage). Both use the same seam.
- Anyone may host the open engine for others under MIT. The moat is the hosted service itself, the product and the
  clients, not withheld code.
