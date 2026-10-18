# boxd sandbox provider

`src/providers/boxd.ts` implements `SandboxProvider` with `@boxd-sh/sdk` 0.2.17. The API was taken from
`node_modules/@boxd-sh/sdk/README.md` and `dist/*.d.ts`.

## Selecting it

| env | effect |
|---|---|
| `CAPCOMD_SANDBOX=boxd` | `providerFromEnv()` in `src/dependencies.ts` returns `BoxdProvider` |
| unset / `fake` | `FakeProvider` (the default, and what every test and chaos run uses) |
| `BOXD_API_KEY` | read by the provider. It is never logged, printed or stored |
| `BOXD_ORG` | optional org to create machines in |
| `CAPCOMD_BOXD_DB` | ledger path (default `.relay/boxd.sqlite`, gitignored) |

Set it for both `capcomd serve` (which hosts the actors that call the provider) and `capcomd run`.

## Idempotent create, crash-safe

The SDK's `machines.create` has **no idempotency-key parameter**. Capcomd gets the same guarantee this way:

1. The VM **name** is derived from the idempotency key: `relay-` + the first 16 hex characters of sha256(idemKey).
   The worker's key already contains run, worker and epoch (`relay-<run>-<worker>-e<epoch>`).
   Machine names are unique, so the name serves as the idempotency key.
2. A SQLite ledger (`boxd_vms`: idem_key → name, vm_id, state) gets an intent row (`creating`)
   **before** `create`. The returned VM id is written (`created`) **before** the VM is used:
   before `setEgressAllow`, exec or anything else.
3. On retry, `ensure` reuses (a) the VM id in the ledger, else (b) the machine found by its
   deterministic name. Case (b) covers a crash after create but before the record. A `ConflictError` on
   create (we lost a race to our own earlier attempt) adopts the machine with that name.
   A recorded VM that is gone or `failed` is recreated.
4. `deleteAfter = ttlSeconds` is set on create. boxd enforces it, so a VM is deleted even if
   capcomd dies and never calls destroy.

## Egress

boxd treats an empty allowlist as **unrestricted**. Capcomd therefore:
- refuses an empty or blank `egressAllow` with `SandboxConfigError`, before any create;
- always calls `setEgressAllow(id, list)` right after create or reuse, before first use. This also matters
  because a VM restored from a snapshot starts unrestricted;
- fails if boxd echoes back an empty list.

`create` takes no allowlist, so the window between create and setEgressAllow has no exec in it.

## Hibernation / keepalive

boxd auto-hibernates idle machines. While capcomd holds a VM, a keepalive timer (default every
30 min, which is well inside the 4h hibernation window; `keepaliveMs`) runs `exec true`. An exec is
inbound, so it resets the idle clock. The timer is unref'd and stops on suspend and destroy. If a VM is
found `hibernated` or `suspended` anyway, `ensure` and `waitReady` wake or resume it.

## Git credentials (pluggable)

There is no credential source in capcomd yet. `BoxdProviderOptions.gitCredentials` is a hook:

```ts
type GitCredentialHook = (ctx: { vmId; labels; cmd }) => Promise<Record<string,string> | null>;
```

It is called before every `git …` exec. The env it returns is passed to **that exec only**, and is
never logged or persisted. The default returns `null`, so git runs with no credentials. A real
implementation should mint a short-lived, per-task token (for example a GitHub App installation token scoped
to one repo) and return, for example, `GIT_CONFIG_COUNT/KEY_0/VALUE_0` setting `http.extraheader`.
Note: the SDK prefixes exec env onto the command line as `K=V`, so it is visible to processes inside
that VM while the command runs. That is acceptable for single-tenant, isolated VMs, but tokens must stay short-lived.

## Typed errors (`src/providers/boxd-errors.ts`)

| class | from |
|---|---|
| `SandboxQuotaError` | `RateLimitError` / gRPC RESOURCE_EXHAUSTED |
| `SandboxTimeoutError` | gRPC DEADLINE_EXCEEDED, or a waitReady timeout |
| `SandboxHibernatedError` | an exec refused while the VM is hibernated/suspended, or a wake that failed |
| `SandboxNotFoundError` | `NotFoundError` / gRPC NOT_FOUND |
| `SandboxConfigError` | a local refusal (empty egress, missing key) |

## Destroy

`destroy` is idempotent (NotFound counts as done) and marks the ledger row `destroyed`.
`executeRun` calls `teardownRun` (worker `drainWorker` → `provider.destroy`) whenever a run ends
`completed`, `failed` or `cancelled`. `capcomd cancel` does the same. `drainWorker` now also resumes a drain
that crashed between DRAIN and VM_DESTROYED.

## Tests

- `tests/providers/boxd.test.ts`: 12 unit tests against a mocked SDK (`bun test tests/providers/boxd.test.ts`).
- `tests/providers/boxd.live.test.ts`: the live test, skipped unless `BOXD_API_KEY` is set. It creates an isolated VM
  with allowlist `["example.com"]`, runs `uname -a && echo ok`, checks that example.com is reachable and
  www.google.com is blocked, destroys the VM and checks it is no longer listed. `afterAll` destroys any VM it
  created even when an assertion fails.

## Known blocker (2026-10-18)

The SDK talks to `boxd.sh:9443`, over gRPC and over grpc-web alike. The capcomd dev box cannot open TCP connections to
port 9443 (443 works). So the live test and the `CAPCOMD_SANDBOX=boxd capcomd run` e2e both fail
with `SandboxTimeoutError ... Deadline exceeded ... Waiting for LB pick` before any VM is created.
Evidence is in `docs/evidence/boxd/`. Run the live test from a network that allows 9443, or set `BOXD_BASE_URL`
to an endpoint you can reach.
