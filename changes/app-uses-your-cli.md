# CHANGELOG

- The Mac app's Homebrew cask (`brew install --cask MarvinAmador7/tap/capcomd-app`) no longer installs the capcomd
  CLI from Homebrew too. The app uses the CLI you already have (install.sh, Homebrew, Bun or npm); if you have none,
  install it with `brew install MarvinAmador7/tap/capcomd` (the cask's caveats and the app's first run say so).
  If you got the CLI only through the cask, run `brew install MarvinAmador7/tap/capcomd` once: Homebrew then keeps it
  as yours, and `brew autoremove` won't remove it as a dependency nothing needs any more.
- The Mac app uses the capcomd your login service runs. With capcomd running as a service (`capcomd service install`),
  the app pairs through that same CLI, even when another one is installed (a Bun install and a Homebrew one, say), so
  it never ends up talking to a different capcomd than the one running. Its first run asks nothing then: Boot no
  longer offers "Start capcomd when I log in" and runs by itself.
- When the app's capcomd is older than the app, it now says to run `capcomd upgrade` (which works however you
  installed it) instead of `brew upgrade capcomd`.
