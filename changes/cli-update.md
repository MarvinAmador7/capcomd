# CHANGELOG

- New `capcomd update`: one command that brings capcomd up to the latest release however you installed it. The
  single executable replaces itself as before; a Bun global install runs `bun add -g capcomd@<version>`, an npm global
  install runs `npm install -g capcomd@<version>`, and Homebrew runs `brew upgrade capcomd`, with their output shown.
  When capcomd is already current it says so and changes nothing. A development checkout still only says what to run.
  If it can't tell which package manager installed capcomd, or that install isn't writable by you, it prints the
  command to run instead (it never uses sudo).
- After an update that changed the version, `capcomd update` restarts the engine when it runs as capcomd's background
  service (`capcomd service install`), and checks that it came back on the new version. `--no-restart` leaves it
  running; without the service, restart `capcomd serve` yourself.
- `capcomd update --dry-run` says which command it would run, the version change and whether it would restart the
  engine, and changes nothing. `--to X.Y.Z` installs that version (not for Homebrew installs). `capcomd upgrade` still
  works, with the same flags and output.

# Spec

`update` is a kernel command (`capcomd update`), so a plugin can't name a command `update`.
