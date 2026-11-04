# capcomd app (macOS)

The capcomd app: a window (each run's agents side by side, [design/desktop](design/desktop/SPEC.md)) and a menu bar
item (projects and approvals in a panel, [SPEC.md](SPEC.md)), talking to the daemon over its socket. The approved
mockups are in [design/](design/README.md). The menu bar item is the app's home; the Dock icon shows while a window is
open.

- `app/`: the SwiftPM package. `CapcomdApp` is the app (its `@main`, the menu bar panel and Settings); the window is
  the `CapcomdDesk` library, which the bench (`CapcomdDeskBench`, [DESKBENCH.md](app/DESKBENCH.md)) hosts too; both
  draw with `CapcomdUI` and read `CapcomdStore`.
- `client/`: `CapcomdClient`, the transport to the daemon (generated from the OpenAPI contract).
- `scripts/`: building the app bundle and its icon.

## Install

`brew install --cask MarvinAmador7/tap/capcomd-app` (it installs the `capcomd` CLI too), or the
`capcomd-app-X.Y.Z.zip` on each [release](https://github.com/MarvinAmador7/capcomd/releases). It isn't notarized by
Apple yet (it's signed ad hoc), so the first open is blocked: click **Done**, then **System Settings › Privacy &
Security › Open Anyway** next to "capcomd", and confirm.

## First run

The app connects by itself (`CapcomdUI/AppSession.swift`, the pure parts in `CapcomdStore/FirstRun.swift`):

1. The token: `CAPCOMD_TOKEN`, else the login Keychain (generic password, service `capcomd`, account your user name:
   the same item the separate menu bar and desktop apps used, so they don't paste again), else it pairs.
2. Pairing: it finds the `capcomd` CLI (`CAPCOMD_CLI`, Homebrew's bins, `~/.capcomd/bin`, Bun's and npm's global bins,
   `~/.local/bin`, then a login shell's PATH; GUI apps don't get the shell's PATH) and runs
   `capcomd clients pair --app mac-app --json` as you. The CLI writes the client and prints the token; the app keeps it
   in the Keychain. Without the CLI the window says how to install it and checks again; pasting a token made with
   `capcomd clients pair --app mac-app` in Terminal always works too.
3. The daemon: when it can't be reached, **Start capcomd** runs `capcomd service install --json` (a LaunchAgent: now
   and at every login).
4. Versions: when the app and the daemon differ in their minor version (0.x), the window and the panel say which to
   update; **Restart capcomd** when the CLI is already new and the old daemon still runs.

The window and the menu bar panel are two views of one app, on the session's one store (`CapcomdStore/AppShell.swift`):

- Every panel row opens the window on its run, at its agent's column (`DeepLink`; an agent without a column lands on
  its nearest ancestor's, else the planner's). **Open capcomd** (⌘O) opens the window; a notification click does what
  a row does. Approve and deny stay in the panel.
- What the window focuses is the store's `selection`; the panel marks that card and agent row. Nothing syncs.
- The menu bar item is the app's home: closing the last window keeps the app running, and the Dock icon (with ⌘-Tab)
  shows only while a window is open (`AppPresence` switches the activation policy). Settings › General: **Show in menu
  bar** and **Keep in Dock**, one of which stays on (`Presence`). Quit is in the panel's + menu.

Notifications come from the panel's model (one banner per notice).

## Run it while developing

```sh
cd apps/menubar/app
swift run CapcomdApp
```

A `swift run` binary has no app bundle, so Settings disables Open at login and notifications ("Available in the
capcomd app"), the About pane says "dev", and there's no version check. Each rebuild is a new binary to the Keychain,
which asks again before the app can read its token. To skip the Keychain while developing, pass the token in the
environment: `CAPCOMD_TOKEN=… swift run CapcomdApp`. `-capcomd.socketPath /path/to/harness.sock` points it at another
daemon, and `CAPCOMD_CLI=/path/to/capcomd` at another CLI (it inherits the app's environment, so `CAPCOMD_HOME` reaches
it). Against your real `~/.capcomd`, a development build that pairs replaces the installed app's token (the installed
app picks the new one up from the Keychain on its next 401), and Start installs the real LaunchAgent.

Tests: `BUN_BIN=$HOME/.bun/bin/bun swift test` in `app/` and in `client/`.

## Build the app

Prerequisites: macOS 14 or later, Xcode or the Command Line Tools (`swift`, `codesign`, `iconutil`, `lipo`, `ditto`),
and [Bun](https://bun.sh) (it draws the icon).

```sh
apps/menubar/scripts/build-app.sh                     # release build for this Mac
apps/menubar/scripts/build-app.sh --debug             # debug build (a debugger can attach)
apps/menubar/scripts/build-app.sh --universal --zip   # what a release ships (the release workflow runs this)
```

The app lands in `apps/menubar/build/capcomd.app` (gitignored), replacing the previous build; `--zip` adds
`build/capcomd-app-<version>.zip` (made with `ditto -c -k --keepParent`) and its `.sha256`. Its version is the
repository's (`package.json`) and its build number the commit count. `--universal` builds arm64 and x86_64 and joins
them with `lipo`.

Run it with `open apps/menubar/build/capcomd.app`, or copy it to `~/Applications` first if you want it to stay put
(Open at login opens the app from where it was when you turned it on). For development, the binary inside still
takes the environment and arguments above:

```sh
CAPCOMD_TOKEN=… apps/menubar/build/capcomd.app/Contents/MacOS/CapcomdApp -capcomd.socketPath /path/to/harness.sock
```

Inside the bundle the app is `dev.capcomd.app`: Open at login and notifications work, and About shows the bundle's
version. Its preferences live under that identifier; on its first launch it copies those of the two apps it replaces
(`dev.capcomd.menubar`, `dev.capcomd.desktop`).

The icon is drawn at build time by `scripts/gen-icon.ts`: the menu bar mark from `packages/bot-avatar` in white on a
rounded square in the brand orange, whole pixels per cell at every size, packed with `iconutil`.

### Signing and the Keychain

The script signs the app (without the hardened runtime or entitlements: it isn't notarized or sandboxed). By default
it signs ad hoc, and macOS sees every build as a different app: after each rebuild the Keychain asks again whether
capcomd may read its token (service `capcomd`), and "Always Allow" only lasts until the next build. Gatekeeper
(`spctl`) rejects an ad hoc app; one you built yourself isn't quarantined, so it opens, while a downloaded one needs
Open Anyway once.

To keep "Always Allow" across rebuilds, sign with a stable identity:

```sh
CAPCOMD_SIGN_IDENTITY="Apple Development" apps/menubar/scripts/build-app.sh
```

Any code-signing identity in your login keychain works (`security find-identity -v -p codesigning` lists them): an
Apple Development certificate, or a self-signed one made in Keychain Access › Certificate Assistant › Create a
Certificate… with the type Code Signing. The value is whatever `codesign --sign` accepts (a unique part of the name
is enough); the script doesn't print it. The first launch after switching identities asks once more.

Notarization (a Developer ID, the hardened runtime, `notarytool` and stapling) isn't set up yet. The script has the
place for it, switched on by `CAPCOMD_NOTARIZE` (it refuses for now), with the steps in a comment there.
