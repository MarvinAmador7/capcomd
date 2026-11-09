# CHANGELOG

- Plugins: every async `ctx` primitive now honours its call options. A call that hasn't answered within `timeoutMs`
  (30 seconds by default) rejects with a retryable `timeout`, and the call may still have taken effect, so re-read
  before retrying. Calls that run a whole operation have longer defaults: `jobs.start` 2 minutes (an `exec` job's
  foreground wait), `agents.spawn` 2.5 minutes, `gates.verify` 2 hours and `gates.merge` 1 hour. Aborting the call's
  `signal` rejects it at once (`timeout`), and disabling, updating or stopping the plugin rejects the calls it still has
  in flight (`disposed`) instead of leaving them to run. A `timeoutMs` that isn't a number above 0 is `invalid`.
  `jobs.wait` and `agents.await` still read `timeoutMs` as how long to wait and answer what is so then.

# Spec

The host bounds every async primitive by its call options (§8.2, `packages/plugin/src/host/context.ts` `guarded`; was "Not built yet"): whichever comes first rejects the call: its `timeoutMs` (a number above 0, else `invalid`) with `timeout`, `retryable`; its `signal` with `timeout`, not retryable (already aborted: at once, the kernel not called); `ctx.signal`, the plugin disposing, with `disposed`, so dispose rejects the calls in flight. The default deadline is 30 000, longer for a primitive that runs a kernel operation to its end: `jobs.start` 120 000 (its `exec` foreground hold of at most 90 000 plus the call's), `agents.spawn` 150 000 (its two modify hooks, 60 s at most each, plus the call's), `gates.verify` 7 200 000 (its checks, then `verify.judging`'s at most 60 min), `gates.merge` 3 600 000 (its landing gates, then it lands or parks), so `context-memory`'s fallback verify and merge aren't cut short. The kernel's implementation is passed the options with that composed signal. `jobs.wait` and `agents.await` keep reading `timeoutMs` as how long to wait (their signals still apply), and a seam call through `sandboxes.provider` keeps its `SeamCall` deadline. `PluginError` `timeout`'s doc names a primitive's `timeoutMs` and `signal`. No hook, seam, route or shape changes.
