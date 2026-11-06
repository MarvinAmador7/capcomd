# @capcomd/plugin

Write plugins for [capcomd](https://github.com/MarvinAmador7/capcomd), the distraction-free agent orchestrator: a
plugin hears what happens to runs, agents, verifications and merges, can judge them (a gate that allows or denies a
merge), and can say things on a run's stream.

This package has everything a plugin needs and nothing it doesn't:

- the manifest schema (`plugin.json`, also as JSON Schema: `@capcomd/plugin/schema`) and its validation;
- the hook names, payloads and results, and the shapes they carry (runs, agents, merges, …);
- `connect()`, the client library a plugin's process uses to talk to the daemon (`@capcomd/plugin/client`);
- the test kit (`@capcomd/plugin/testkit`): a fake context, sample payloads, the load/dispose and hook-contract checks,
  and `bootWith`, which boots a real daemon with your plugin on the fake sandbox.

```sh
npm install @capcomd/plugin      # or: bun add @capcomd/plugin
```

A third-party plugin runs as its own process, started and supervised by the daemon. The smallest one:

```ts
import { connect, sessionOpen } from "@capcomd/plugin";

const client = connect();                       // the socket and token the daemon gave this process
await client.open(sessionOpen());               // the handshake: this start's session, manifest hash and hooks
for await (const frame of client.hooks(new AbortController().signal)) {
  if (frame.frame !== "hook.call") continue;
  if (frame.call.hook === "merge.landing")      // a gate: answer before the call's deadline
    await client.answer(frame.call.callId, { session: client.session, result: { decision: "allow" } });
}
process.exit(0);                                // the daemon stopped the plugin, or went away
```

The guide is [docs/plugins.md](https://github.com/MarvinAmador7/capcomd/blob/main/docs/plugins.md): the manifest,
the hooks, secrets and settings, testing, shipping and installing. The normative reference is the plugin API spec,
[docs/spec/plugin-api.md](https://github.com/MarvinAmador7/capcomd/blob/main/docs/spec/plugin-api.md). Worked
examples are in [packages/plugin/examples](https://github.com/MarvinAmador7/capcomd/tree/main/packages/plugin/examples).

The package is versioned with capcomd: `@capcomd/plugin@X.Y.Z` is the API of capcomd X.Y.Z. Works on Node ≥ 20 and Bun.
MIT licensed.
