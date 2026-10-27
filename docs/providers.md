# Sandbox providers

Agents run in sandboxes from a provider, chosen with `CAPCOMD_SANDBOX` (ADR-020):

| `CAPCOMD_SANDBOX` | Sandboxes | Snapshots | Host-bound secrets | Egress allowlist | Needs |
|---|---|---|---|---|---|
| `boxd` | cloud VMs ([boxd](https://boxd.sh)) | ✓ | ✓ | ✓ | a boxd account (`BOXD_API_KEY`) |
| `docker` | containers on this machine | ✓ (images) | – | – | Docker: Docker Desktop, OrbStack, Colima, or Podman's docker |
| `fake`, `fake-host` | nothing (tests) | | | | |

## Docker

```bash
export CAPCOMD_SANDBOX=docker
capcomd env build              # a container from node:22-bookworm with the pinned agent CLIs, committed as an image
capcomd auth login claude      # a plan login, kept in a local image (capcomd-auth-…), never on the host
capcomd serve                  # the engine also removes expired sandbox containers every 5 minutes
```

Env snapshots and plan logins are kept per sandbox. To prepare Docker while the daemon runs on boxd (for runs started
with `--sandbox docker`, or Local in the menu bar app), pass the sandbox instead of exporting it:
`capcomd env build --sandbox docker`, `capcomd auth login claude --sandbox docker`.

- **Where it finds Docker:** `CAPCOMD_DOCKER_BIN`, `docker` on PATH, or OrbStack's and Docker Desktop's usual
  places. The base image is `CAPCOMD_DOCKER_IMAGE` (default `node:22-bookworm`: node, git, coreutils, util-linux).
- **A sandbox is a container** named after the agent's idempotency key, with capcomd's labels; it lives until the
  agent ends (or its delete-after time passes, if the engine went away). `docker ps --filter
  label=dev.capcomd.sandbox=1` lists them.
- **Differences from boxd:**
  - Isolation is a container, not a VM: the agent can't see your files, but a kernel exploit would reach the host.
  - No host-bound secrets: an API key (auth `apikey`) reaches the agent in its environment, where it can read it.
    Plan logins (auth `subscription`) are unaffected.
  - No egress allowlist: containers get Docker's network. Agents have open egress by default anyway; a profile that
    sets `egress` is refused on Docker rather than run unrestricted. The checks sandbox (verify and merge) has open
    network too.
  - `capcomd secrets sync` is a boxd feature; on Docker there's nothing to sync.

## Writing a provider

1. Implement `SandboxProvider` (`src/providers/sandbox.ts`):
   - `ensure(spec)`: create the sandbox for `spec.idemKey`, or return the one that exists (idempotent, also across
     a crash); boot from `spec.fromSnapshot` when given; `ttlSeconds` is when it may be deleted if nobody renews it
     (`extendTtl`).
   - `exec(id, argv, {env, cwd, timeoutMs})`: run argv (no shell), with that env added, and kill it at the timeout;
     return `{code, stdout, stderr}`. Commands started detached (`setsid nohup … &`) must outlive the exec: the agent
     runs that way and later execs poll it.
   - `upload` / `download` absolute paths (parent directories exist), `destroy` (idempotent), `list(prefix)`.
   - Git network commands (`git clone/fetch/push`) get the per-exec credentials of a `GitCredentialHook`.
2. Add its descriptor to `PROVIDERS` in `src/providers/registry.ts` (ADR-021), and create it in `providerFromEnv`
   (`src/dependencies.ts`). The descriptor is what the engine asks (`sandboxCaps()`) and what the daemon serves to
   clients as data (`GET /v1/sandboxes`), so the app needs no change for a new place:

   ```ts
   lima: {
     name: "lima", descriptorVersion: 1, label: "Local VM", kind: "local", vendor: "Lima", title: "Local VM · Lima",
     mark: "lima", listed: true,
     caps: { isolation: "vm", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true,
             idleLifetime: "sweep", shell: true },
     settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"],
     actions: ["open_terminal", "delete"],
   },
   ```

   - `label`, `vendor`, `title`: what clients call it ("Local VM", and "Local VM · Lima" on its details screen);
     `kind` (`local` or `cloud`) groups it and picks the app's fallback glyph; `mark` is the id of a mark the app may
     bundle (an unknown one falls back to the glyph). `listed: false` keeps it out of clients' lists (the test fakes).
   - `isolation`: `vm`, `container`, or `host` (tests only);
   - `snapshots`: also implement `snapshotCreate/Get/List/Delete` (`src/env/platform.ts`) for `capcomd env build`
     and plan logins;
   - `hostBoundSecrets`: `secretSet/List/Delete`, where the agent sees only a placeholder;
   - `egressAllowlist`: whether `spec.egressAllow` is enforced (`["*"]` means unrestricted);
   - `interactive`: `streamExec` with a terminal, for `capcomd auth login`;
   - `idleLifetime`: who deletes a machine left behind once `ttlSeconds` is up: `platform` (the provider does, like
     boxd's delete-after), `sweep` (capcomd's engine does, like Docker's ledger and 5-minute sweep), or `none`;
   - `shell`: `capcomd sandbox shell` can open an interactive shell in a live machine (`streamExec` with a terminal,
     or the provider's own CLI, like `docker exec -it`);
   - `settings`, `info`, `actions`: the rows and resource actions its details screen offers, from the closed lists in
     the registry (`SETTING_IDS`, `INFO_IDS`, `RESOURCE_ACTIONS`). The daemon serves only the actions it implements.

   A listed provider also needs an availability check in `src/api/run-options.ts` (`AVAILABLE`: cheap and local, like
   "is a key configured" or "does the CLI answer", cached), and its `list(prefix)` should fill `createdAt` and
   `deleteAt` when it knows them: `GET /v1/sandboxes/{name}/resources` shows them. Machines must be named with
   `MACHINE_PREFIX` (`src/providers/sandbox.ts`): that is how capcomd finds its own, and `capcomd sandbox shell` only
   accepts ids that carry it.
3. Run the conformance suite against it (`tests/providers/conformance.test.ts`: add it to `subjects`).
