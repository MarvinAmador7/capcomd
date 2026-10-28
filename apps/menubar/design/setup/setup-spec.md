# Inline project setup: spec (v1)

Status: **approved on the design canvas; built.** The boards are `setup/Inline*.dc.html` (HTML with inline CSS, the panel
at 380 pt) and they win wherever this text and they differ. The earlier window boards (`SetupWindow`, `SetupComposer`,
`SetupAttention`) were **not** approved and aren't in the repo: there is no setup window. Swift:
`app/Sources/MenuBarApp/ProjectSetupInline.swift` (views, the `SetupActions` adapter), `StartProjectField.swift` (where
it sits), `Theme.Setup`; the logic and what each state shows: `app/Sources/CapcomdStore/ProjectSetupFlow.swift`
(`ProjectSetupFlow`, `SetupScreen`), tested in `Tests/CapcomdStoreTests/ProjectSetupFlowTests.swift`.

## 1. Where it lives

- The composer's **+** menu › **Choose Project Folder…** (and the folder chip when it says "Default project") opens the
  folder picker. A folder that is already a capcomd project becomes where new runs go at once, as before. Any other
  folder keeps the composer card and swaps its **tool row** (+, Local / Cloud, the driver menu, Send) for that folder's
  next steps, under the goal field. No separate window, no sheet.
- The folder chip shows the picked folder's name with the **orange dot** (7 pt, `#ff9f0a`, "Not set up") before its ×.
  While the folder is being looked at, the chip shows a small spinner instead and the tool row stays (no flash for a
  folder that turns out to be set up).
- New runs keep going to the **previous project** until the folder is set up. **Cancel**, the chip's **×** and **Esc**
  (in the goal field or anywhere in the panel) drop the folder and go back to it. A setup cancelled while it was on its
  way is undone in the app the same way: new runs go back to the previous project.
- The panel's height follows the content (`Theme.Panel`, max 640 pt). While the next steps show and nothing runs, the
  empty **Active** section ("Nothing running") steps aside, as on the boards; active runs still show.
- When the daemon has no default project and asks for a folder on Start (`needsRepo`), the picked folder goes through the
  same flow: a set-up project takes the run; any other shows its next steps with the goal kept, so **Set Up and Start**
  finishes the job.

## 2. States (`InlineSetup`, `InlineAttention`, `InlinePublish`)

Header line (`.nh`): the orange dot, then the sentence in 12.5 pt medium. Rows (`.r`) and their notes (`.rn`) follow, or
a callout (`.callout`); the buttons (`.acts`) close the card.

| State (from the daemon) | Header | Body | Buttons (left · right) |
|---|---|---|---|
| GitHub checkout, not set up (`problems: []`) | "my-app isn't set up for capcomd yet." | Repository, Target branch, Changes land as, Agents, Spend cap (only when asked, §3) | Cancel · **Set Up** / **Set Up and Start** / **Setting Up…** |
| GitHub CLI logged out (`ghReady: false`) | as above | Changes land as is **Pushes to main**; orange note under it "Pull requests need the GitHub CLI logged in." + **Log In…** (mini) | as above |
| A value refused (`422` with `field`) | as above | the daemon's sentence in orange under that row, until that answer changes (it stays while trying again: "Setting Up…") | as above |
| A refusal about no row (`path`, `check`, none) | as above | the sentence in orange over the buttons | as above |
| Not a git checkout (`not_git`) | "Downloads isn't a git checkout." | callout "Initialize Git to start a repository in this folder, or choose your repository's folder." | Choose Another Folder… · **Initialize Git** |
| Git, not on GitHub (`not_github`) | "docs-site isn't on GitHub." | callout "Its repository is `gitlab.com/acme/docs-site`. The app sets up GitHub projects; for others, run `capcomd setup project` in Terminal." | Choose Another Folder… · **Open in Terminal** |
| No origin (`no_origin`) | "my-app isn't on GitHub yet." | Account (you, then "Organizations"), Name (150 pt field), Visibility (Private / Public); callout "Creates `github.com/marvin/my-app`, commits the folder's 24 files as the first commit, and pushes `main`." ("Creates … and pushes `main`." when it has commits) | Choose Another Folder… · **Publish to GitHub** |
| Publishing | as above | the rows locked at 50 %; callout "Pushing `main` to `github.com/marvin/my-app`…" | **Publishing…** (spinner) only |
| Published | the usual setup | "Published just now, private." (grey) under Repository | Cancel · **Set Up** |
| No origin, GitHub CLI logged out | "my-app isn't on GitHub yet." | callout "Publishing needs the GitHub CLI logged in on this Mac." | Choose Another Folder… · **Log In to GitHub…** |
| Home folder, missing folder, unknown problem | "<name> can't be set up." | the daemon's sentence | Choose Another Folder… |
| The folder couldn't be read | "<name> couldn't be checked." | the store's sentence | Choose Another Folder… · **Try Again** |

Done: the dot goes, the tool row comes back and the goal field takes focus (board 4). **Set Up and Start** sets the folder
up, then starts the run with the typed goal (the field clears, as a started run does); a run that doesn't start leaves the
composer's usual red line.

Not on the boards, so kept minimal: the "can't be set up" and "couldn't be checked" states; "Log in to Claude Code or Codex
in Settings › Accounts first." (orange, under Agents) when no agent is logged in anywhere; "An amount in USD over 0, or
empty for no limit." under a spend cap that isn't one; "Initializing…" on the primary while git starts; files the daemon
won't publish listed at the end of the publish callout ("Leaves out `.env` (reason).").

## 3. Rows and copy

| Row | Value | Edits | From |
|---|---|---|---|
| Repository | the GitHub mark and `owner/name` | no (never typed: it is the folder's origin) | `github` |
| Target branch | a menu (`.pop`): the default branch, the checkout's branches, the current pick; then a separator and "Branches on GitHub" | pick | `defaultBranch`, `branches` |
| Changes land as | "Pull requests" or "Pushes to <target>"; Pull requests is disabled while the GitHub CLI is logged out | pick | `suggestedMode`, `pullRequestsAvailable` |
| Agents | chips: Claude Code (its coral spark), Codex; on = accent capsule; one not logged in anywhere is dimmed and can't be chosen | toggle; at least one | `agents[].loggedIn`, `suggestedAgents` |
| Spend cap | "$" field, 76 pt, "5.00" to start; note "Claude Code bills your API key. A run stops at this amount." | type; empty is no limit | shown only when a chosen agent bills an API key **where new runs go** (the composer's Local / Cloud: its `places[]` entry for that place is `how: "api_key"`, and its `auth` is `apikey`, so a plan login anywhere never asks) |

Owner's decisions: **no Check row** (setup sends the daemon's `suggestedCheck`), no "Saved in .capcomd" / "commit to
share" notes, agents as chips, the spend cap row only as above, the primary is "Set Up" or "Set Up and Start" (a goal is
typed). Return in the goal field presses Set Up (and Start); Return elsewhere presses the card's primary.

Picked answers survive a fresh look at the folder (back from Terminal): an answer the person changed stays while it still
applies; the rest follow the daemon's new suggestions (logging the GitHub CLI in brings Pull requests back).

## 4. Measurements (`Theme.Setup`)

Card: the composer card (20 pt corners, 12 pt padding, 12 pt gap). `.next`: a 0.5 pt hairline (white 10 %) across the
card's full width, 10 pt above the header. Header: dot 7 pt, gap 8, 12.5 pt medium #F2F2F7, 2 pt inset. Rows: 8 pt under
the header; 32 pt min height including 3 pt vertical padding; label column 84 pt, 12 pt, 55 % #EBEBF5; value 12.5 pt,
right-aligned, gap 6; 0.5 pt hairlines (white 7 %) between rows. Notes: 11 pt, 50 % #EBEBF5 (orange when they need
doing), 8 pt below; mini button 20 pt high, 5 pt corners, white 10 %, 11.5 pt. Menus: 22 pt, 6 pt corners, white 10 %,
8 / 5 pt padding, up/down chevrons. Fields: 22 pt, 6 pt corners, black 25 %, white 16 % hairline, 12 pt mono; refused:
orange edge and a 2.5 pt orange ring at 25 %. Agent chips: 24 pt capsules, 7 / 9 pt padding, 12 pt; on: accent 18 % fill,
55 % edge. Callout: 12.5 pt, 70 % #EBEBF5, line height 1.45, mono 11 pt, 8 pt above. Buttons: 12 pt above, gap 8; 27 pt
high, 7 pt corners, 12.5 pt medium; primary accent, secondary white 10 %, Cancel text only (70 %); disabled or busy 55 %;
spinner 11 pt.

## 5. Data (`ProjectSetupFlow` → the store)

| Step | Call | Notes |
|---|---|---|
| Look at the folder | `store.inspectProject(path:)` → `projectInspect` | `configured` and nothing blocking: becomes `prefs.startRepo` at once. `.failed("Update capcomd…")` (no `projects.setup`): the folder is taken as before |
| Set Up | `setUpProject(path:mode:target:check: suggestedCheck, agents:budgetUsd:)` → `projectSetup` | `.saving` → "Setting Up…"; `.refused(message, field)` → under the row; `.done` → the store sets `prefs.startRepo` and reads run options; a 409 inspects again |
| Initialize Git | `store.initGit(path:)` | then inspect again (→ `no_origin`) |
| Publish options | `store.loadPublishOptions(path:)` → `projectPublish` `.ready(ProjectPublishOptions)` | `ghReady`, `accounts {login, kind}`, `suggestedName`, `hasCommits`, `files`, `blocked {path, reason}` |
| Publish | `store.publishProject(path:owner:name:visibility:)` → `.publishing`, `.refused(message, field)`, `.failed` | then inspect again: the usual setup with "Published just now, private." |
| Keep `.capcomd/` out of git | `setUpProject(…, gitignore:)` | Settings › General › New projects (`capcomd.gitignoreCapcomd`, off by default) |

Initialize Git, publishing and `gitignore` come with the store's project git routes (`store.projectGitSupported`). Until
this app has them, `SetupActions` (ProjectSetupInline.swift) says they're unavailable: the not-a-checkout and no-origin
states show the daemon's sentence with Choose Another Folder… only, and the General switch is disabled ("Update capcomd
to use this."). The swap is one place: each `SetupActions` member names its store call.

Terminal hand-offs: **Log In…** / **Log In to GitHub…** run `gh auth login`; **Open in Terminal** runs
`capcomd setup project` in the picked folder. Coming back to the panel looks at the folder again (a project set up in
Terminal becomes where runs go).

Mock daemon: `PROJECTS=ready|configured|notgit|notgithub|nogh|apikey|refuse|old` (`client/mock/projects.ts`).

## 6. Settings › General › New projects (`settings/Main.dc.html`, `GeneralLight.dc.html`)

Between Menu bar and Notifications: **Keep .capcomd/ out of git** (switch, off), sub "Adds `.capcomd/` to the project's
.gitignore when you set it up. Off: commit it, so everyone who works on the project shares the setup.", foot "Applies to
projects you set up from now on."

## 7. Open

- The target menu's "Branches on GitHub" is the board's copy, but `branches` are the checkout's local branches.
- Codex's chip uses the app's stand-in Codex glyph (as everywhere) until the official mark lands; the board draws a
  terminal glyph.
