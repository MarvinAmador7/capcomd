# capcomd menu bar app

A SwiftUI menu bar app for capcomd: runs, agents, approvals and threads, talking to the daemon over its socket.
What it shows and why: [SPEC.md](SPEC.md) and the approved mockups in [design/](design/README.md).

- `app/`: the SwiftPM package (the `CapcomdMenuBar` executable and its store, thread and bot targets).
- `client/`: `CapcomdClient`, the transport to the daemon (generated from the OpenAPI contract).
- `scripts/`: building the app bundle and its icon.

## Run it while developing

```sh
cd apps/menubar/app
swift run CapcomdMenuBar
```

A `swift run` binary has no app bundle, so Settings disables Open at login and notifications ("Available in the
capcomd app") and the About pane shows the version this source belongs to. Each rebuild is a new binary to the
Keychain, which asks again before the app can read its token. To skip the Keychain while developing, pass the token
in the environment: `CAPCOMD_TOKEN=… swift run CapcomdMenuBar`. `-capcomd.socketPath /path/to/harness.sock` points it
at another daemon.

Tests: `BUN_BIN=$HOME/.bun/bin/bun swift test` in `app/` and in `client/`.

## Build the app

Prerequisites: macOS 14 or later, Xcode or the Command Line Tools (`swift`, `codesign`, `iconutil`), and
[Bun](https://bun.sh) (it draws the icon).

```sh
apps/menubar/scripts/build-app.sh            # release build
apps/menubar/scripts/build-app.sh --debug    # debug build (a debugger can attach)
```

The app lands in `apps/menubar/build/capcomd.app` (gitignored), replacing the previous build. Its version is the
repository's (`package.json`) and its build number the commit count. It's a menu bar app: no Dock icon, except while
Settings is open.

Run it with `open apps/menubar/build/capcomd.app`, or copy it to `~/Applications` first if you want it to stay put
(Open at login opens the app from where it was when you turned it on). For development, the binary inside still
takes the environment and arguments above:

```sh
CAPCOMD_TOKEN=… apps/menubar/build/capcomd.app/Contents/MacOS/CapcomdMenuBar -capcomd.socketPath /path/to/harness.sock
```

Inside the bundle the app is `dev.capcomd.menubar`: Open at login and notifications work, and About shows the
bundle's version. Its preferences live under that identifier, separate from those of a `swift run` binary.

The icon is drawn at build time by `scripts/gen-icon.ts`: the menu bar mark from `packages/bot-avatar` in white on a
rounded square in the brand orange, whole pixels per cell at every size, packed with `iconutil`.

### Signing and the Keychain

The script signs the app (without the hardened runtime or entitlements: it isn't notarized or sandboxed). By default
it signs ad hoc, and macOS sees every build as a different app: after each rebuild the Keychain asks again whether
capcomd may read its token (service `capcomd`), and "Always Allow" only lasts until the next build. Gatekeeper
(`spctl`) rejects an ad hoc app, but one you built yourself isn't quarantined, so it opens.

To keep "Always Allow" across rebuilds, sign with a stable identity:

```sh
CAPCOMD_SIGN_IDENTITY="Apple Development" apps/menubar/scripts/build-app.sh
```

Any code-signing identity in your login keychain works (`security find-identity -v -p codesigning` lists them): an
Apple Development certificate, or a self-signed one made in Keychain Access › Certificate Assistant › Create a
Certificate… with the type Code Signing. The value is whatever `codesign --sign` accepts (a unique part of the name
is enough); the script doesn't print it. The first launch after switching identities asks once more.
