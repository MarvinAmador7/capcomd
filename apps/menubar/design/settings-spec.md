# Settings window: spec (v1)

Status: **approved on the design canvas; built.** The boards are `settings/*.dc.html` (HTML with inline CSS) and
they win wherever this text and they differ. `settings/CloudExplore.dc.html` is a place's Details screen (§4.1), built
read-only for ADR-021 phase 1, minus what the owner removed (below). Swift: `app/Sources/MenuBarApp/Settings*.swift`;
the data and its mapping: `app/Sources/CapcomdStore/Settings.swift` and `Sandboxes.swift`.

## 1. Window

- The system `Settings` scene: a `TabView` with the toolbar tab style and SF Symbols (General `gearshape`, Accounts
  `person.crop.circle`, Runs `square.stack.3d.up`, About `info.circle`). Each pane is a `Form` with
  `.formStyle(.grouped)`, so rows, controls, headers and footers are the system's.
- **620 pt** wide. The height fits the pane (switching panes resizes the window). The window title is the pane's
  name. Dark and light follow the system (`Main.dc.html`, `GeneralLight.dc.html`).
- No OK/Cancel/Apply: every change applies at once. Destructive actions ask first (an alert with a destructive
  button). Anything that must run in a terminal opens Terminal with the command ready (`TerminalLauncher`, a throwaway
  `.command` file, no Automation permission); the row then says "Waiting for Terminal…" and updates by itself. Settings
  never shows a token or key.
- Opening it: **⌘,** (the app menu's Settings…) and **Settings…** in the project composer's `+` menu. The panel closes.
  An accessory app can't become active, so while Settings is open the app is a regular app (a Dock icon, as Apple's
  own menu bar apps do) and its window comes to the front with active controls; closing the window makes it an
  accessory again.
- Each pane reports its content height and the window fits it (top edge fixed, no animation) inside the screen's
  visible frame (no menu bar, no Dock): a window that would run under the Dock moves up first; only a pane taller than
  the whole visible height is capped and scrolls. ⌘W closes it. Panes have no ⌘1–4: Settings
  windows don't, and ⌘1–3 stay the panel's.
- Freshness: while the window is open, `GET /v1/health`, `/v1/run-options`, `/v1/logins`, `/v1/environments` and
  `/v1/service` are read every 5 s (all cheap) and again whenever the app becomes active (back from Terminal).
- System controls, system accent, SF Pro. Brand orange and the bots only on About and the menu bar mark. Status dots
  use the system green, orange and red, and the text always says the state too.
- Places are named **Local** (Docker on this Mac) and **Cloud** (boxd), never VM. There is no socket path row
  anywhere (owner: it could break the app).

## 2. General (`Main.dc.html`)

**capcomd**

| Row | Shows | Does |
|---|---|---|
| Status | "Connected · capcomd 0.6.0" (green dot; the version from `/v1/health`). Unreachable: "Can't reach capcomd" (red), sub "Trying again every few seconds.", **Start capcomd** (prominent: Terminal `capcomd service install`). Also "Waiting for Keychain access…", "Not connected" + **Paste Token…**, "capcomd rejected this app's token" + **Paste Token…** | |
| Keep capcomd running | Toggle, sub "Starts it at login and restarts it if it stops, so agents keep working after you close Terminal." | On: Terminal `installCommand`. Off: asks first ("Stop keeping capcomd running?" · "capcomd stops now, and so does any run in progress. It won't start at login until you turn this on again." · **Turn Off**), then Terminal `uninstallCommand`. Unreachable and not on: **Turn On…**, sub "Off: capcomd stops when you close the Terminal it runs in." |

Footer while unreachable: "Rows that need capcomd (logins, environments) say so until it's back." A daemon without
`service` hides the row: "To keep capcomd running after you close Terminal, run `capcomd service install`."

**Menu bar**: **Open at login** (`SMAppService.mainApp`; status read each time the pane shows; "requires approval"
adds "Allow capcomd in System Settings › General › Login Items." and **Open Login Items…**; without an app bundle the
toggle is disabled: "Available in the capcomd app. This build runs without an app bundle."). **Bot faces** (sub "The
menu bar bot naps when nothing runs and raises a hand when something needs you.", the mark as it is now on a 32 pt
tile, then the toggle). Off: the menu bar mark stays the plain face (no sleepy, working or approval faces); the amber
dot and count stay.

**Notifications**: **Approval requests** ("Approve or deny a merge from the notification.") and **Finished runs**
("Including runs that failed or were stopped."), both on by default; they gate the notifications the app posts.
Footer: "Banners and sounds follow System Settings › Notifications." (a link to that pane); when notifications are
denied: "Notifications are off for capcomd. Turn them on in System Settings › Notifications."

## 3. Accounts (`Accounts.dc.html`)

One section per AI (**Claude** with its spark in coral, **Codex** with its stand-in glyph), rows **Cloud** ("boxd
machines") then **Local** ("Docker on this Mac").

| State | Value | Button |
|---|---|---|
| Plan | "Logged in with your Claude plan" (ChatGPT for Codex), green | Log In Again… |
| API key | "Using an API key", green | Log In Again… |
| Can run (older daemon) | "Logged in", green | Log In Again… |
| Not logged in | "Not logged in", empty ring | **Log In…** (prominent for the AI new runs start with) |
| Unknown | "Unknown", empty ring | Log In… |
| Waiting | "Waiting for Terminal…" (spinner), sub "Finish logging in in the Terminal window.", footer "Opened: `command`" | Show Terminal |

Log In opens Terminal with the login's `command`. Footer (after Codex): "Log In opens Terminal with the command ready,
so your login never passes through this app. Each place agents run keeps its own login. On Cloud, a login is kept as
a boxd secret that only works on its AI's API (api.anthropic.com, api.openai.com), so it can't be sent anywhere else."

**boxd** › API key: "Saved in your keychain" + Change…, or "Not set" + **Set Up…** (Terminal `capcomd setup
accounts`); from run-options' `boxd` place. Footer "Agents on Cloud run on boxd machines, billed to this key."

**This app** › App token (sub "Can read runs, message agents and approve merges"): "Saved in your keychain" +
**Reset…**; "From CAPCOMD_TOKEN" (no button); "Not set" / "capcomd rejected it" + **Paste Token…**. Footer "The menu
bar app talks to capcomd with its own token. Reset it if it may have been copied: the old one stops working at once."
Reset… asks first (`States.dc.html`: the smiling bot, "Reset the app token?", "This app gets a new token, and the old
one stops working at once. Anything else using it needs the new one.", Cancel / **Reset** destructive), then Terminal
revokes the active clients named `menubar` and runs `capcomd clients add menubar --scopes read,steer,approve`, and a
sheet takes the new token. (`capcomd clients list` has no token hashes, so the app's client is found by that name.)

## 4. Runs (`Runs.dc.html`)

**New runs**: Project (popup: "Default project", the remembered folder, "Choose Folder…"), Driven by (popup with the
provider marks; a driver that can't run in the default place is disabled), Effort (popup with signal bars; "Auto"
first when the driver has no default effort, sub "How hard the planner thinks. Auto lets Claude Code decide."), Runs
on (popup of every place in `run-options` `sandboxes`, "Local · Docker", "Cloud · boxd", sub "Where new runs go. More
clouds show here as capcomd supports them."). Footer "The composer starts with these. Picking something else there
changes them here too." Runs on, each place's Default badge / **Make Default**, and the composer's Local / Cloud switch
are one setting (`startSandbox`): the place last picked anywhere. The composer uses it while it can be used.

One section per place, header: its mark (Docker's one-colour mark for Local; the cloud glyph for Cloud until boxd's
own), "Local · Docker on this Mac" / "Cloud · boxd", then **Default** (accent badge) or **Make Default**, then
**Details…** (§4.1) when capcomd describes its places (`sandboxes`). With `sandboxes`, nothing in the section depends on
a place's name: the header is the descriptor's `title` and `mark`, the status row is labelled with its `vendor` and
says "Running" (`kind: local`) or "Ready" (cloud), an unavailable place shows the daemon's reason (the empty ring and
**Set Up…** when the reason names a plain capcomd command to run, as "No boxd API key (run capcomd setup)" does; red
otherwise), and the footer says "Agents work in containers on this Mac." (or "virtual machines") from `kind` and
`caps.isolation`. Without it, the rows are as below, by name.

| Row | States |
|---|---|
| Docker / boxd | "Running" / "Ready" (green); Docker's reason in red ("Docker isn't running"); "No boxd API key" + **Set Up…** |
| Agent environment | Ready: sub "Claude Code 2.1.303 · Codex 0.163.0 · built Oct 24", **Rebuild…** (`command --force`). Not built: orange "Not built", sub "Not built yet: runs on Local can't start until it is.", **Build…**. Building: a linear progress bar, sub "Installing Claude Code and Codex. This takes a few minutes; you can close Settings.", Show Log (Terminal) while Terminal runs, footer "Runs on Local start once it's built.". Failed: red "Failed", sub "The last build didn't finish. Terminal shows why when you try again.", **Try Again…** |

Footers: Local "Agents work in containers on this Mac."
The last place: "An agent environment holds the agents' tools, built once for each place they run. It never holds
logins or keys."

### 4.1 A place's details (`CloudExplore.dc.html`; ADR-021 phase 1)

**Details…** pushes one generic screen in place of the Runs pane (not a sheet: the pane's content swaps, the window
fits it like any pane and is titled "Runs › Cloud"); "‹ Runs" at the top, ⌘[ or Esc goes back. The sections and their
order are fixed here, as on the board; which rows appear and what they say come from the daemon. Everything is
read-only in phase 1 except Open in Terminal. Owner's removals from the board: no "Sites agents can reach" row and no
"can't limit sites" copy (site access isn't a capcomd setting), no cost, no "asleep" machines.

| Section | Rows | From |
|---|---|---|
| Header | mark, `title`, Default / Make Default (as in Runs) | `GET /v1/sandboxes` descriptor |
| (status) | the availability row (as in Runs); then any `status` rows the daemon sends (a provider's key); then Agent environment (as in Runs, with Build… / Rebuild…) | `/v1/sandboxes`, `/v1/sandboxes/{name}` `info`, `/v1/environments` |
| Machines | one row per machine: a dot (green running, orange left behind, ring starting / stopping), "worker · Add an abs(a) function…" (role · the task's first line) or "Left behind · no agent owns it", its age ("4 min", "2 h"), **Open in Terminal**; owned machines first, newest first; the tooltip adds the machine's id and when it is deleted if left idle. "No machines running." when there are none. Then "Delete idle machines after" (`idleLifetime`): a disabled popup showing its value ("1 hour") and help | `GET /v1/sandboxes/{name}/resources`, every 5 s while the screen shows; `idleLifetime` from `settings` |
| Safety | **Logins**: "Bound" (green) when every login here is bound to its AI's API, "Codex isn't bound" (orange) when some aren't, "Not bound" when none are, "No logins"; the sub names the hosts. **Checkpoints**: the daemon's `display` ("After each commit and every 10 minutes"). Footer: "Local (Docker) can't bind logins to a host; Cloud does." from the descriptors' `caps.hostBoundSecrets` | `/v1/logins` `hostBound` / `boundTo`; `info` rows |
| Options | settings this app doesn't place (only when there are any) | `settings` |

Rows render by field type: `choice` → popup (disabled in phase 1), `toggle` → switch (disabled), `info` / `status` →
a value (a `status` row's `state` picks its dot); a type the app doesn't know shows its `label` and `display`
read-only. A value set in capcomd's environment (`source: "env"`) shows the daemon's `display` instead of a control.
Marks are bundled by id (`PlaceMarks`): `docker` the official mark, `boxd` the cloud glyph for now; an unknown id gets
`desktopcomputer` (local) or `cloud`.

- **Stale list**: when the provider didn't answer (`stale: true`), the last list stays with a quiet footer
  "Couldn't reach boxd just now. These are the machines it listed at 10:22." A failed read of the route itself keeps
  the last list the same way.
- **Open in Terminal** asks the daemon for the machine (`GET …/resources/{id}`) and runs its `terminalCommand`
  (`capcomd sandbox shell run-8kq2 agt-41`, or `--sandbox boxd --machine …` for one left behind) in Terminal. The app
  never builds the command, and runs it only when it is a plain capcomd command (`SettingsRows.isSafeCommand`); anything
  else beeps and the footer says nothing was opened. A machine that's gone says "This machine is gone."
- **Older daemons**: without `sandboxes`, no Details… and Runs is as above; without `sandboxes.resources`, no machine
  list and the first section's footer says "Update capcomd to see machines here."

## 5. About (`About.dc.html`)

One centred column, no Form: the brand mascot (orange, `BrandBot`, happy) at 128 pt, the pixel wordmark at 6 pt cells
(204 × 30), "Agent orchestration for your Mac", "App 0.6.0 · capcomd 0.6.0" (the bundle's version, else the source's;
capcomd's from `/v1/health`, or "capcomd isn't connected"; selectable), GitHub / Changelog / Report an Issue… (system
buttons, github.com/MarvinAmador7/capcomd), "MIT License".

## 6. Data and older daemons

| Route (capability) | Feeds | Without it |
|---|---|---|
| `GET /v1/health` `version`, `capabilities` | Status, About | "Connected", "capcomd isn't connected" |
| `GET /v1/logins` (`logins`) | Accounts rows | run-options: per place with `runs.options.sandbox` (a reason about logging in → Not logged in; another reason → Unknown); else only the daemon's own place, the others Unknown, footer "Update capcomd to see every login here." |
| `GET /v1/environments` (`environments`) | Agent environment rows | rows hidden; footer "Update capcomd to see each place's agent environment here." |
| `GET /v1/service` (`service`) | Keep capcomd running | row hidden, footer naming `capcomd service install` |
| `GET /v1/run-options` (`runs.options`) | New runs, places, boxd key | Driven by, Effort, Runs on and the place sections hidden: "This version of capcomd can't list drivers or places to run. Update capcomd to choose them here." |
| `GET /v1/sandboxes`, `/v1/sandboxes/{name}` (`sandboxes`) | Place headers and status rows, Details… (§4.1) | places shown by name as before; no Details… |
| `GET /v1/sandboxes/{name}/resources[/{id}]` (`sandboxes.resources`) | Machines, Open in Terminal | no machine list: "Update capcomd to see machines here." |

While capcomd can't be reached, daemon rows keep their last values, disabled, with "Shown when capcomd is running."
Commands from the daemon reach Terminal only when they are plain capcomd invocations (`SettingsRows.isSafeCommand`).
The mock daemon serves all of this: `SETTINGS=mixed|fresh|building|failed|ready|old` (`client/mock/settings.ts`), and
the place routes with `SANDBOXES=machines|stale|empty|unsafe|nores|off` (machines running and one left behind; boxd
not answering; none; a `terminalCommand` the app must refuse; `sandboxes` without `sandboxes.resources`; none of it).

## 7. Later

Log out (a route that doesn't exist yet), building an environment in the app with real progress (today Terminal does
it; the bar is indeterminate), changing a place's settings ("Delete idle machines after"; ADR-021 phase 2, the
`configure` scope) and Delete… on a machine (phase 3), Permissions (who am I), naming the default project, updates.
