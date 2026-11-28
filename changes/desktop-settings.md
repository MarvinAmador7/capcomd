# CHANGELOG

- Desktop app: **Settings is redesigned.** One window in the app's dark look, with a sidebar and a page: Search, then
  capcomd's status (Running and its version, or Not running), then General, Notifications, Interface, Shortcuts, Runs,
  Accounts and About, each with its own icon. Back and Forward (⌘[ and ⌘]) walk the pages you opened.
  - **Search** finds any setting, login or place by name; Return opens the first result and highlights its card.
  - **capcomd** (the status row): start capcomd when it isn't running, keep it running in the background, and reset
    this app's token. These moved here from General and Accounts.
  - **General › App Icon:** pick the Dock icon (Orange, Night or Mono) and the menu bar icon (Dome, Antenna or Ring).
    **Show app icon** (Dock and menu bar, Dock only, Menu bar only) replaces the Show in menu bar and Keep in Dock
    switches, so the app can't end up with neither. Bot faces is now **Menu bar moods**. The version card says
    whether the app and the running capcomd match, and offers Restart capcomd when an update left the old one running.
  - **Notifications:** new **Usage limits** (a notification when an agent's AI hits its usage limit and its run
    pauses) and **Badge app icon** (the Needs you count on the Dock icon). Both are on unless you turn them off.
  - **Interface:** the window's layout (the reel or the sidebar, the same choice ⌃⌘S makes); **Columns across** (fit
    the window, or always 1, 2 or 3); **Crew tabs** (the bot and its title, or the bot only); and whether **Follow asks
    and failures** is on when the window opens.
  - **Shortcuts:** the window's keyboard shortcuts, read-only.
  - **Runs:** new runs' **Model** joins Project, Driven by, Effort and Runs on. Each place is one row that shows the
    one thing it needs (for example "Agent environment not built"); click it for the place's own page with its agent
    environment, machines, safety and options (the Details… sheet is gone).
  - **Accounts:** when the AI new runs use isn't logged in where they run, Accounts shows an amber count and that row's
    Log In… stands out.
