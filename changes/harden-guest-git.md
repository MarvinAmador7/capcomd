# CHANGELOG

- Security: capcomd now treats the git work that comes back from an agent's machine as untrusted. Before an agent's
  commits reach your repository, the host checks the bundle they arrive in and refuses it, with the reason, when it
  names an unexpected or malformed ref (`../`, control characters), fails git's object checks (a `.git` folder in any
  spelling), or carries a symlink into `.git` or a `.gitmodules` trick such as a carriage return in a submodule path
  (CVE-2025-48384). The agent's push then fails with that reason, and nothing of it reaches your repository.
- Security: git on the host never runs a hook, fsmonitor or submodule command on an agent's work. Verifying, merging
  and pushing it ignore your system and global git settings, except your commit signing settings and Git LFS. A
  `.gitattributes` in an agent's commit therefore can't select one of your merge drivers, and a symlink is checked out
  as a plain file (it stays a symlink in the commit).
- Security: your own filters other than Git LFS (for example git-crypt) no longer decode files sent to agents'
  checks. LFS files still arrive as real files, fetched from your LFS server with your credentials as before. An
  agent's commit that adds or changes `.lfsconfig` (where LFS fetches from) is refused; change it on the target
  yourself.
- **Breaking:** your own git hooks (a global `core.hooksPath`, `pre-commit`, `commit-msg`, `pre-push`) no longer run
  on capcomd's merge commits and pushes, so a hook can no longer veto a merge. Put that check in the project's checks
  (`run.checks`), which run on the merged code before it lands.

# Spec

Hostile git from a sandbox (§11.7 item 5): a sandbox's bundle is taken (`receiveBundle`, replacing `fetchBundle`) only with a plain v2/v3 header holding the one ref asked for under a plain ref name, after `git bundle verify` and `index-pack --strict` (`.git` in any spelling, `.`, `..`, `/` and empty names as errors) into a quarantine, with no new commit's symlink into `.git` and no `.gitmodules` control character, option-like path or URL, path out of the tree or `update` command, and no change to a root `.lfsconfig`; a refused one fails the push (`TransferError` kind `refused`). Every host repo's git runs under one policy: no hooks (the user's global ones included), fsmonitor, submodule recursion, symlinks or transport, `core.protectHFS`/`protectNTFS`, and for local work no system or global config but the user's signing settings and, when they have Git LFS, its filter with their `lfs.*`, `credential.*`, `http.*`, `url.*` and ssh settings (no other filter).
