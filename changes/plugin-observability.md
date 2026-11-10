# CHANGELOG

- `capcomd trace <run>` shows each plugin hook call as a `plugin.hook` span (which plugin, which hook, and whether it allowed, denied, held, was skipped or failed and why), and a plugin's own `ctx.trace.span` spans under the call they ran in.
- A plugin's log lines in the daemon log carry the `runId`, `agentId`, `traceId` and `spanId` of the hook call they were written in.
- Sandbox spans in a run's trace name the plugin that provides the sandbox (`plugin`).
- `GET /v1/plugins` `stats.seams` (capability `plugins.seam_stats`) counts the daemon's calls to each seam a plugin provides and its failed ones by error kind; `capcomd plugins show <name>` prints them with the hook call statistics, live from the running daemon.

# Spec

With plugin observability as §13.3-§13.5 say: every hook call is written as a `plugin.hook` span into the run's trace (a child of the agent's span), `call.trace` names the call's own span, `ctx.trace.span` spans are children of the active call (redacted, with their own `plugin` name, and never the kernel's `relay.*` attributes), a log line carries the call's run, agent, trace and span, seam spans carry `plugin`, and `stats.seams` (capability `plugins.seam_stats`) counts seam calls and errors by `ErrorClass.kind`; §13.5's `capcomd doctor` is now `capcomd plugins show`.
