# CHANGELOG

- Plugins: every async `ctx` primitive now honours its call options. A call that hasn't answered within `timeoutMs`
  (30 seconds by default; `jobs.start` 2 minutes, to cover an `exec` job's foreground wait) rejects with a retryable
  `timeout`, and the call may still have taken effect, so re-read before retrying. Aborting the call's `signal` rejects
  it at once (`timeout`), and disabling, updating or stopping the plugin rejects the calls it still has in flight
  (`disposed`) instead of leaving them to run. A `timeoutMs` that isn't a number above 0 is `invalid`. `jobs.wait`
  still reads `timeoutMs` as how long to wait and answers the job as it is then.

# Spec

The host bounds every async primitive by its call options (§8.2, `packages/plugin/src/host/context.ts` `guarded`; was "Not built yet"): whichever comes first rejects the call: its `timeoutMs` (default 30 000; `jobs.start`'s 120 000, its `exec` foreground hold of at most 90 000 plus the call's; a number above 0, else `invalid`) with `timeout`, `retryable`; its `signal` with `timeout`, not retryable (already aborted: at once, the kernel not called); `ctx.signal`, the plugin disposing, with `disposed`, so dispose rejects the calls in flight. The kernel's implementation is passed the options with that composed signal. `jobs.wait` keeps reading `timeoutMs` as how long to wait (its signals still apply), and a seam call through `sandboxes.provider` keeps its `SeamCall` deadline. `PluginError` `timeout`'s doc names a primitive's `timeoutMs` and `signal`. No hook, seam, route or shape changes.
