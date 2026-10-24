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
2. Add its entry and capabilities to `src/providers/registry.ts`, and create it in `providerFromEnv`
   (`src/dependencies.ts`):
   - `isolation`: `vm`, `container`, or `host` (tests only);
   - `snapshots`: also implement `snapshotCreate/Get/List/Delete` (`src/env/platform.ts`) for `capcomd env build`
     and plan logins;
   - `hostBoundSecrets`: `secretSet/List/Delete`, where the agent sees only a placeholder;
   - `egressAllowlist`: whether `spec.egressAllow` is enforced (`["*"]` means unrestricted);
   - `interactive`: `streamExec` with a terminal, for `capcomd auth login`.
3. Run the conformance suite against it (`tests/providers/conformance.test.ts`: add it to `subjects`).
