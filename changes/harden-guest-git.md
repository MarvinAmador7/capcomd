# CHANGELOG

- Security: capcomd now treats the git work that comes back from an agent's machine as untrusted. Before an agent's
  commits reach your repository, the host checks the bundle they arrive in and refuses it, with the reason, when it
  names an unexpected or malformed ref (`../`, control characters), fails git's object checks (a `.git` folder in any
  spelling), or carries a symlink into `.git` or a `.gitmodules` trick such as a carriage return in a submodule path
  (CVE-2025-48384). The agent's push then fails with that reason, and nothing of it reaches your repository.
- Security: git on the host never runs a hook, fsmonitor, submodule command or filter on an agent's work. Verifying,
  merging and pushing it ignore your system and global git settings (only your commit signing settings are kept), so
  a `.gitattributes` in an agent's commit can't select one of your filters or merge drivers, and a symlink is checked
  out as a plain file (it stays a symlink in the commit).
- **Breaking:** your own git hooks (a global `core.hooksPath`, `pre-commit`, `commit-msg`, `pre-push`) no longer run
  on capcomd's merge commits and pushes, so a hook can no longer veto a merge. Put that check in the project's checks
  (`run.checks`), which run on the merged code before it lands.
- **Breaking:** files stored with Git LFS (or another filter of yours, such as git-crypt) reach the checks VM as git
  stores them (an LFS pointer, the encrypted bytes), not smudged on the host. Have the checks fetch what they need.

# Spec

Hostile git from a sandbox (§11.7 item 5): a sandbox's bundle is taken (`receiveBundle`, replacing `fetchBundle`) only with a plain v2/v3 header holding the one ref asked for under a plain ref name, after `git bundle verify` and `index-pack --strict` (`.git` in any spelling, `.`, `..`, `/` and empty names as errors) into a quarantine, with no new commit's symlink into `.git` and no `.gitmodules` control character, option-like path or URL, path out of the tree or `update` command; a refused one fails the push (`TransferError` kind `refused`). Every host repo's git runs under one policy: no hooks (the user's global ones included), fsmonitor, submodule recursion, symlinks or transport, `core.protectHFS`/`protectNTFS`, no LFS filter, and for local work no system or global config but the user's signing settings.
