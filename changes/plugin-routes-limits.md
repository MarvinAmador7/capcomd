# CHANGELOG

- A plugin's API route (`/v1/x/<plugin>/…`) now refuses a request body over 1 MiB with 413 (`invalid`) before the
  plugin sees it, and answers 504 (`timeout`) when the plugin hasn't answered within 30 seconds, so a webhook sender or
  client is never left hanging. The plugin's request signal is aborted at that moment.
- A plugin whose manifest declares two API routes of the same method that could both match one path with as many
  parameters (`/a/{x}/c` and `/a/b/{y}` both match `/a/b/c`) now fails to load with `invalid_manifest`, naming both
  routes, instead of one of them winning by the order they were registered. `capcomd plugins validate` reports it too.

# Spec

Limits and ties for API routes (§4.7.3, from the gap review): a request body over 1 MiB is 413 `invalid` before the handler runs, read no further than that whatever its content-length; a handler that hasn't answered within 30 s is 504 `timeout` (a new additive `ApiError` code), its `signal` aborted with a `PluginError` `timeout` and its late answer dropped. Two declared routes of one method that could both match a path with as many parameters each are refused by the manifest validator (`invalid_manifest`, naming both), and `ctx.api.route` throws `conflict` for the second of such a pair registered at runtime (a manifest that wasn't validated); a literal beside a parameter still resolves to the literal.
