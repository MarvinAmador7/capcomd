# ADR-020: Sandbox providers as a contract, and Docker as the second one

**Status:** proposed (2026-10-24). Step 1 (the registry and capabilities) is built; Docker is next.

## Context

Agents run in sandboxes from a `SandboxProvider` (`src/providers/sandbox.ts`): boxd cloud VMs, or a fake for tests.
boxd was wired in beyond that interface:

- code asked for it by name (`CAPCOMD_SANDBOX === "boxd"`) to decide where checks run, whether to check
  credentials before a run, whether a spawn needs an env snapshot, and whether `capcomd run` plans with an agent;
- three boxd features are used through extra, duck-typed methods: **snapshots** (`capcomd env build` bakes the agent
  CLIs into an image; `capcomd auth login` keeps a plan login in an "auth snapshot"), **host-bound secrets** (an API
  key the platform swaps in on egress to one host, so the agent sees only a `bxds_` placeholder) and **egress
  allowlists** (a profile's `egress`; the checks VM reaches only the package registries);
- an interactive terminal for logins (`streamExec`), and platform-enforced VM deletion (`deleteAfter`) as the
  backstop for a lost engine.

capcomd should run without a cloud account. The user chose Docker as the second provider (Docker Desktop, OrbStack,
Colima, Podman with a docker shim): most developers have it, on macOS and Linux.

## Decision

### 1. A registry of providers with declared capabilities (built)

`src/providers/registry.ts` lists each provider by the name `CAPCOMD_SANDBOX` takes, with what it can do:

| Capability | Meaning | fake | fake-host | boxd | docker |
|---|---|---|---|---|---|
| `isolation` | where an agent's commands run | host | host | vm | container |
| `snapshots` | saved images to boot from | – | – | ✓ | ✓ (images) |
| `hostBoundSecrets` | the agent sees a placeholder, never the key | – | – | ✓ | – |
| `egressAllowlist` | egress limited to a list of hosts | – | – | ✓ | – |
| `interactive` | a terminal for logins | – | – | ✓ | ✓ |

Code asks for the capability, never the name: checks run in the provider's sandbox and credentials are checked
before a run when `isolation` isn't `host`; a spawn needs an env snapshot when the provider has `snapshots`.

### 2. Docker

- **A sandbox is a container** from the env image, kept alive by a long-running PID 1 (the agent is started detached
  and polled by later execs, as on boxd), named and labelled by the spawn's idempotency key so `ensure` is
  idempotent and a sweep can find them. `exec` is `docker exec` (argv, env, cwd, a timeout that kills it), `upload`
  and `download` stream through `docker exec` (no host paths are mounted).
- **Snapshots are images.** `capcomd env build` installs the pinned CLIs in a container from the base image and
  commits it (`capcomd-env:<hash>`); a plan login commits the container after `capcomd auth login` (`capcomd-auth-…`),
  so the login stays in a local image, as it stays in a boxd snapshot. Workers boot from them.
- **No host-bound secrets.** An API key reaches the agent in its environment (credential mode `env`, already
  supported). Plan logins are unaffected (they live in the auth image).
- **No egress allowlist.** Containers get the network Docker gives them. Agents default to open egress already
  (ADR-019 §7); a profile that restricts `egress` is refused on Docker rather than run unrestricted, and the checks
  sandbox is a container with open network (documented: it no longer reaches only the package registries).
- **Interactive logins** run inside the container under a pseudo-terminal (`script`), fed through `docker exec -i`.
- **Deletion.** Docker doesn't delete containers by itself: each carries its delete-after time, and the engine
  sweeps expired ones (on start and periodically); `extendTtl` moves the time as on boxd.
- **The binary:** `docker` on PATH, or OrbStack's `~/.orbstack/bin/docker`, or `CAPCOMD_DOCKER_BIN`.
- **Isolation is a container, not a VM**: weaker against a kernel exploit. Codex keeps `danger-full-access` (the
  container is the boundary), as Claude keeps bypassing permission prompts.

### 3. A conformance suite

`tests/providers/conformance.ts` runs the same cases against every provider that is available (Docker when a daemon
answers): idempotent `ensure`, exec semantics (exit codes, env, cwd, timeout), upload/download round trips, a
detached process surviving its exec, `destroy` idempotent, `list` by prefix, and the capability-specific cases
(snapshots, interactive). A new provider passes it before it is listed.

## Consequences

- `capcomd setup` offers the provider (boxd or Docker) and checks it (a boxd key, or a Docker daemon).
- `capcomd secrets sync` stays boxd-only (it needs `hostBoundSecrets`); on Docker it explains why.
- Docs: "Writing a provider" (the interface, the capabilities, the conformance suite).

## Plan

1. The registry and capabilities; boxd checks become capability checks (no behavior change).
2. The Docker provider and the conformance suite; `env build` on Docker.
3. Plan logins and setup on Docker, the docs, and the live e2e on Docker.
