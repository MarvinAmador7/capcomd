# Security policy

capcomd runs coding agents with access to your repositories and credentials, so its isolation and gates are
security boundaries. We take reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/MarvinAmador7/capcomd/security/advisories/new).

Include what an attacker can do, the steps or a proof of concept, and the version (`capcomd --version`). We'll
acknowledge the report, keep you updated while we work on a fix, and agree on a disclosure date with you; we credit
reporters in the advisory unless you'd rather we didn't.

## What's in scope

Anything that breaks a boundary capcomd claims to enforce, for example:

- an agent (or text it writes) acting outside its own subtree: spawning, cancelling, reading or merging what its
  capability token doesn't allow, or forging or reusing a token;
- a merge landing without a passing `verify`, or landing a different commit than the one verified;
- credentials leaking: a boxd key, an agent login or a host secret reaching a VM, a log, a trace, an event or the
  output contract where it shouldn't;
- checks VMs reaching more than the package registries, or receiving more than the code tree;
- the engine or the in-VM RPC accepting requests it should refuse.

Out of scope: what an agent does inside its own VM with the permissions you gave it, vulnerabilities in boxd,
Claude Code, Codex or Rivet themselves (report those upstream; tell us if capcomd makes them worse), and the
`fake` sandbox, which is for tests and isolates nothing.

## Supported versions

Fixes go into the latest release. While capcomd is 0.x, upgrade to the newest version to get them.
