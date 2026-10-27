# Settings window: draft spec (v1)

Status: **draft for the owner's review.** The visual design happens on the design canvas; this file is the written
contract for it. Nothing here changes `../SPEC.md` or the Swift app yet. Every row names its source of truth, and
whether that source exists today:

- **today**: the app already has it (a pref, a store value, a route it calls).
- **app**: new app-side work only (no daemon change).
- **CLI**: only the CLI can do or see it today. v1 hands off to Terminal, or needs a daemon gap (§6) to show status.
- **gap**: needs a daemon route that doesn't exist (§6).

## 1. Window

- A SwiftUI `Settings` scene (new `SettingsView.swift`) holding a `TabView` of panes. Each pane is a
  `Form { … }.formStyle(.grouped)`. The tab bar is the system toolbar tab bar with SF Symbol icons.
- Width fixed at **560 pt**. Height fits the pane: switching panes resizes the window, top edge pinned (system
  behaviour). The window title is the pane's name. Dark and light follow the system.
- No OK/Cancel/Apply. Every change applies at once. Destructive actions ask first (an `alert` with a destructive
  button). Actions that must run interactively open Terminal with the command (the existing `TerminalLauncher`: a
  throwaway `.command` file, so no Automation permission is needed). Settings never shows a token or key.
- Opening it: **⌘,** while the panel is key (the Settings command in the hidden app menu), and a "Settings…" entry
  in the panel (see open question 1). The app is an accessory app, so it calls `NSApp.activate()` before
  `openSettings` or the window opens behind other apps.
- Materials: standard window and Form materials. No Liquid Glass inside the panes (they are content). The toolbar
  is the system's (it gets glass on macOS 26 by itself). No pixel art except the About pane's identity moment. No
  custom chrome.
- Freshness: while the window is open, re-read `GET /v1/run-options` (cheap, "poll freely") every 5 s, when the
  window becomes key, and when the app becomes active again after a Terminal hand-off. Do the same for the gap
  routes once they exist.

## 2. Panes

| Pane | Symbol | Why it's in v1 |
|---|---|---|
| **General** | `gearshape` | Is capcomd running and reachable, start at login, what new runs default to, notifications. This is where people check that it works. |
| **Accounts** | `person.crop.circle` | Who the agents act as: the app's capcomd token, the Claude and Codex logins (one per sandbox, matching the login ledger), the boxd key. This is the most common reason a run is refused. |
| **Sandboxes** | `shippingbox` | Where agents run: Local (Docker) and VM (boxd), whether each can be used now, and each one's agent environment, which has to be built once. |
| **About** | `info.circle` | The identity moment: wordmark, mascot, the app's and capcomd's versions, links. |

**Later (not v1), and why:**

- **Shortcuts.** The shortcuts are fixed (⌘K, ⌘1–3, ⌘[). A global summon key needs a custom status item (SPEC §4.9).
- **Agent profiles** (`capcomd agents …`, `.capcomd/agents.json`). Power-user editing with a schema. The CLI is
  the right tool for now.
- **Menu bar.** Only one mark is approved, and the badge is the one allowed number. Nothing to choose yet.
- **Advanced.** A socket path override already exists as `defaults write … capcomd.socketPath`. v1 shows the path
  read-only.
- **Updates** (`capcomd upgrade`). See open question 5.

## 3. Rows

Labels are sentence case, and the copy below is exact. `code` in a footnote renders as SF Mono. Provider marks:
Claude's spark (one colour) and `circle.hexagongrid.fill` for Codex until the official asset arrives.

### 3.1 General

**Section "capcomd"**

| Row | Control | Source | Today |
|---|---|---|---|
| Status | `LabeledContent`: status symbol + text. "Connected · capcomd 0.6.0", "Can't reach capcomd. Reconnecting…" (mini `ProgressView`), "Waiting for Keychain access…", "Not connected" with trailing **Paste Token…** | `store.daemonUnreachable`, `AppModel.tokenPending` / `needsToken`; version from `GET /v1/health` `version` | state today. The version is in the health response, but the app doesn't keep it yet (**app**) |
| Background service | `LabeledContent` "On" / "Off". When Off, trailing **Install…** opens Terminal with `capcomd service install` | the launchd plist `~/Library/LaunchAgents/dev.capcomd.engine.plist` + `launchctl print gui/$UID/dev.capcomd.engine` (read by the app); CLI `capcomd service status --json` | **app** (reads launchd itself, which also works while the daemon is down). Install is **CLI** |
| Socket | `LabeledContent`, mono, middle-truncated, path as tooltip, text selectable: `~/.capcomd/harness.sock` | `AppModel.socketPath` (`capcomd.socketPath` default, else `~/.capcomd/harness.sock`) | today |

Footnote: "The app talks to capcomd on this Mac. If capcomd isn't running, install the background service so it
starts at login, or run `capcomd serve`."

**Section "Startup"**

| Row | Control | Source | Today |
|---|---|---|---|
| Open at login | `Toggle` | `SMAppService.mainApp` register/unregister; read `status` each time the pane appears (System Settings can change it) | **app**. Needs a bundled app: under `swift run` it's disabled with the footnote "Available in the capcomd app." |

When `status == .requiresApproval`: footnote "Allow capcomd in System Settings › General › Login Items." plus the
button **Open Login Items…** (`SMAppService.openSystemSettingsLoginItems()`).

**Section "New runs"**. Footnote: "The Start field uses these, and what you pick there changes them here."

| Row | Control | Source | Today |
|---|---|---|---|
| Project | `Picker` (menu): "Default project", the remembered folder (its name, full path as tooltip), divider, "Choose Folder…" (opens `ProjectFolderPicker`) | pref `startRepo` (nil = the daemon's default) | today. Naming the default project is gap **D5** |
| Driven by | `Picker` (menu): each driver with its provider mark and `label` ("Claude Code", "Codex"). An unavailable driver is disabled and shows its `reason` as secondary text | pref `startDriver`, effective value `AppModel.startDriver`; list from `GET /v1/run-options` `drivers` | today |
| Effort | `Picker` (menu). Claude Code: "Auto", "Low", "Medium", "High", "Extra high", "Max". Codex: "Minimal", "Low", "Medium", "High". "Auto" is shown only when the driver's `effort` is null. Each item has its `cellularbars` level, like the composer | pref `startEffort.<provider>` (`"auto"` = Auto); levels from `drivers[].efforts` | today. The row is hidden when the driver lists no efforts |
| Runs on | `Picker` (`.segmented`): "Local" (`laptopcomputer`) and "VM" (`cloud`). An unavailable one is disabled, and its `reason` shows as the section footnote | pref `startSandbox` (`docker` / `boxd`), effective value `AppModel.startSandbox`; list from `run-options` `sandboxes` | today |

Without the `runs.options` capability, Driven by, Effort and Runs on are hidden, and the footnote reads: "This
version of capcomd can't list drivers and sandboxes. Update capcomd to choose them here."

**Section "Notifications"**

| Row | Control | Source | Today |
|---|---|---|---|
| Approval requests | `Toggle` (default on) | new pref `notifyApprovals`, checked in `Notifier.post` | posting today. The toggle is **app** |
| Finished runs | `Toggle` (default on) | new pref `notifyRunFinished` | posting today. The toggle is **app** |

Footnote: "Approve and Deny work right in the notification. Approving asks for your password or Touch ID."
(`.authenticationRequired`, today.) When the system authorization is denied, a row reads "Notifications are off for
capcomd." with **Open System Settings…** (Notifications pane), and both toggles are disabled. Read it with
`getNotificationSettings` each time the pane appears. Under `swift run` (no bundle), the section is disabled with
"Available in the capcomd app."

### 3.2 Accounts

**Section "capcomd"** (this app's own access)

| Row | Control | Source | Today |
|---|---|---|---|
| App token | `LabeledContent`: "Saved in Keychain" / "Not set" / "capcomd rejected it" (red `xmark.circle`) / "From CAPCOMD_TOKEN" (development; button hidden). Trailing **Replace Token…** (**Paste Token…** when not set) opens a sheet: `SecureField`, **Connect** (default), Cancel | Keychain generic password, service `capcomd`, account `NSUserName()`; `store.unauthorized`; `AppModel.submitToken` | today (the `TokenPrompt` flow, moved into a sheet) |
| Permissions | `LabeledContent` "Read · Steer · Approve" | gap **D4** | **gap**, so hidden in v1 |

Footnote: "Make a token with `capcomd clients add menubar --scopes read,steer,approve` and paste it here. capcomd
shows it only once."
(Copy fix: `TokenPrompt` says "Paste the token from `capcomd token`", but no such command exists. The token comes
from `capcomd clients add`.)

**Section "Claude"** (spark mark in the header) and **Section "Codex"** (placeholder mark): one row per sandbox.

| Row | Control | Source | Today |
|---|---|---|---|
| Local (Docker) | `LabeledContent` status (§4.2). Trailing **Log In…** when there's no login or it's invalid ("Log In Again…") | ledger `auths-docker.json`, via gap **D1**; today only `capcomd auth status --quick --json` with `CAPCOMD_SANDBOX=docker` | **gap** (status) / **CLI** (login) |
| VM (boxd) | same | ledger `auths.json`, via **D1**; CLI with `CAPCOMD_SANDBOX=boxd` | **gap** / **CLI** |

**Log In…** opens Terminal with `CAPCOMD_SANDBOX=<docker|boxd> capcomd auth login <claude|codex>`. Accessibility hint:
"Opens Terminal to log in." Section footnote (identical for both providers, with the provider's plan name): "Logging
in happens in Terminal. capcomd starts a sandbox and gives you a link to sign in with your Claude plan. Each sandbox
keeps its own login. If the agent environment isn't built yet, capcomd builds it first. This page updates when
you're done."

Until D1 lands, the only daemon signal is `run-options` `drivers[].available` / `reason`, which covers only the
daemon's own sandbox. v1 without D1 shows that one row ("Not logged in to Codex (run capcomd auth login codex)" →
"Not logged in"), and shows the other sandbox's row as "Unknown" with **Log In…**.

Log Out is not in v1 (gap **D6**). When it lands: a "Log Out…" button that asks first. Alert title: "Log out of Claude
on VM?". Message: "Agents on VM can't use your Claude plan until you log in again." Buttons: **Log Out**
(destructive), Cancel.

**Section "boxd"**

| Row | Control | Source | Today |
|---|---|---|---|
| API key | `LabeledContent`: "Saved" / "Not set". When Not set, trailing **Set Up…** opens Terminal with `capcomd setup accounts` | `run-options` `sandboxes[boxd].available` / `reason` ("No boxd API key (run capcomd setup)") | today (status) / **CLI** (setup) |

Footnote: "VMs run on boxd and need a boxd API key. `capcomd setup` stores it for you (Keychain or `~/.capcomd/credentials`)."

### 3.3 Sandboxes

**Section "Local"** (header `laptopcomputer`, "Local", secondary "Docker on this Mac")

| Row | Control | Source | Today |
|---|---|---|---|
| Status | `LabeledContent`: "Ready" / "Docker isn't running" / "Docker isn't installed" | `run-options` `sandboxes[docker]` `available` / `reason` | today |
| Agent environment | `LabeledContent` (§4.3). Trailing **Build…** (missing), **Rebuild…** (failed), nothing while building | gap **D2**; CLI `CAPCOMD_SANDBOX=docker capcomd env status --json` (`snapshots[].current`, `status`, `record.builtAt`) | **gap** (status) / **CLI** (build) |

Footnote: "Agents run in containers on this Mac. They can't see your files, but a container is less isolated than a
VM. The agent environment holds the agent tools and your project's dependencies, never secrets."

**Section "VM"** (header `cloud`, "VM", secondary "boxd cloud machines")

| Row | Control | Source | Today |
|---|---|---|---|
| Status | "Ready" / "No boxd API key", with **Set Up…** (Terminal `capcomd setup accounts`) | `run-options` `sandboxes[boxd]` | today |
| Agent environment | same as Local, with `CAPCOMD_SANDBOX=boxd` | **D2** / CLI | **gap** / **CLI** |

Footnote: "Agents run on their own cloud machines, with host-bound secrets and an egress allowlist."

**Build…** opens Terminal with `CAPCOMD_SANDBOX=<sandbox> capcomd env build` (**Rebuild…** adds `--force`). Build
in-app is gap **D3**. Pane footnote: "capcomd's default is VM. Choose where new runs go in General." (From the
sandbox with `default: true`; omitted when none is the default.)

### 3.4 About

Not a `Form`: one centred column, no sections.

- The pixel **CAPCOMD wordmark** (catalog glyphs, whole-point cells), and under it the mascot (the brand's orange
  planner bot, `full` at 64 pt, idle pose). Both are opaque, never on glass, never outlined. The bot is decorative
  (`accessibilityHidden`); the wordmark reads "capcomd".
- "capcomd for Mac", then "Version 0.6.0 (build)" (`CFBundleShortVersionString` / `CFBundleVersion`). Then
  "capcomd 0.6.0" from `/v1/health` `version`, or "capcomd isn't connected". Both are selectable, so they can be
  copied into a bug report.
- Links as a row of link buttons: **GitHub** (`https://github.com/MarvinAmador7/capcomd`), **Changelog**
  (`…/blob/main/CHANGELOG.md`), **Report an Issue** (`…/issues`).
- Small print: "MIT License". Claude's mark: simple-icons, CC0.
- Moment: when the pane appears, the mascot blinks once (a 120 ms sprite swap, the hover blink from SPEC §4.9). Not
  under Reduce Motion. Never loops.

## 4. States

### 4.1 Connection (every pane)

| State | What shows |
|---|---|
| Waiting for Keychain | General › Status "Waiting for Keychain access…". Rows from the daemon show "—" |
| No token / rejected | General › Status "Not connected" with **Paste Token…**. Accounts › App token "Not set" / "capcomd rejected it" |
| Daemon unreachable | General › Status "Can't reach capcomd. Reconnecting…" (spinner, secondary colour, never red). Daemon-sourced rows keep the last values but are disabled, and their sections get the footnote "Shown when capcomd is running." App-side rows (Open at login, Notifications, Project, Socket, Background service) stay live. Background service **Install…** is the way out |
| Older daemon | No `runs.options`: §3.1's footnote. A gap route returning 404 shows the row as "Update capcomd to see this here." |

### 4.2 Login row (per provider × sandbox)

| State | Text | Symbol | Action |
|---|---|---|---|
| Logged in (verified) | "Logged in with your plan · checked Oct 24" | none (done has no mark) | — |
| Logged in (not checked) | "Logged in with your plan" | none | — |
| API key | "Using an API key" | none | — |
| Not logged in | "Not logged in" | none (secondary text) | **Log In…** |
| Invalid | "Login didn't work. Log in again." | `xmark.circle` red | **Log In Again…** |
| Unknown (no D1, other sandbox) | "Unknown" | none | **Log In…** |

### 4.3 Agent environment row

| State | Text | Symbol | Action |
|---|---|---|---|
| Ready | "Ready · built Oct 24" | none | — |
| Missing | "Not built yet" | none | **Build…** |
| Building | "Building…" | mini `ProgressView` | none |
| Failed | "The last build failed." | `xmark.circle` red | **Rebuild…** |
| Unavailable | "Needs Docker" / "Needs a boxd API key" | none | (the Status row has the action) |

Until D2/D3 land, Building can't be observed, so v1 shows only Ready / Missing / Failed. A Terminal hand-off then
refreshes when the app becomes active again.

## 5. Keyboard and accessibility

- ⌘, opens, ⌘W closes. Panes are reachable with Full Keyboard Access, like any Settings toolbar. Settings binds no
  ⌘1–3 / ⌘[ / ⌘K: those stay panel-scoped.
- Return is the sheet's default button (Connect). Esc cancels the sheet and alerts.
- Each status row is one VoiceOver element: label + value ("Claude, VM, not logged in. Log In, button, opens
  Terminal to log in."). Provider marks carry "Claude" / "Codex". The bots are decorative.
- State is never colour-only: text always says it, and failures add the red `xmark.circle`. Hierarchical SF
  Symbols.
- Increase Contrast and Reduce Transparency: system Form behaviour, no custom fills to adapt. Reduce Motion: the
  About blink is skipped. The spinners are system controls.
- Dynamic Type: system sizes, so labels can wrap to two lines and values tail-truncate with tooltips.

## 6. Daemon gaps

Today the API has `/v1/health`, `/v1/run-options` and the run routes. Nothing about logins, environments or the
calling client.

| # | Need | Proposal | Unblocks |
|---|---|---|---|
| **D1** | Login status per provider × sandbox | `GET /v1/auth` → `[{provider: claude\|codex, sandbox: docker\|boxd, state: "plan"\|"apikey"\|"none"\|"invalid", verifiedAt?, detail}]`, from each sandbox's ledger (`auths.json`, `auths-docker.json`) and API-key presence. Quick, no VM boot (as `auth status --quick`). `read` scope | Accounts login rows. Today `run-options` reports only the daemon's own sandbox, and only as a driver's `available` |
| **D2** | Agent environment status per sandbox | `GET /v1/environments` → `[{sandbox, state: "ready"\|"missing"\|"building"\|"failed", name?, builtAt?, versions?}]` (as `env status --json`, plus building) | Sandboxes › Agent environment |
| **D3** | Build from the app, observable | `POST /v1/environments/{sandbox}/build` (`steer` scope, Idempotency-Key) + `env.build_started/finished/failed` on the `daemon` stream | In-app Build without Terminal, and a live Building state |
| **D4** | Who am I | `GET /v1/whoami` → `{clientId, label, scopes}` | Accounts › Permissions, and a clear message before a 403 |
| **D5** | Name the default project | `/v1/run-options` adds `defaultRepo: {label, path} \| null` | General › Project shows "Default project (relay)" instead of a bare "Default project" |
| **D6** | Log out | `POST /v1/auth/{provider}/{sandbox}/logout` (`steer` scope) | Accounts › Log Out… (later) |

Not daemon gaps: background service status (the app reads launchd), Open at login, notification prefs. Login itself
stays in Terminal by design (an interactive device or setup-token flow in a sandbox). A later route could return
the sign-in URL and code for the app to show.

## 7. Open questions for the owner

1. **Entry point from the panel.** The panel has no footer (SPEC §4.9). Where does "Settings…" go: in the project
   composer's `+` menu, as a small gear beside the "Active" label, or only ⌘,?
2. **Four panes or three?** Logins are per sandbox, so Accounts could fold into Sandboxes (each sandbox: status,
   environment, Claude, Codex). The proposal keeps Accounts separate because "am I logged in?" is the question
   people ask.
3. **Ship order.** Should D1/D2 land in the daemon before v1, so the login and environment rows show real status?
   Without them, v1 shows only the daemon's own sandbox and Terminal buttons. Recommendation: D1 and D2 first (small,
   read-only), D3–D6 later.
4. **Finished-run notifications.** On by default, or only failures? Approvals stay on.
5. **Updates.** When the app's and capcomd's versions differ, should About offer "Update capcomd…" (Terminal
   `capcomd upgrade`)? Or should updates stay out of Settings (Homebrew/npm say how)?
