# CHANGELOG

- Desktop: with the sidebar open you can **split** the pane. ⌘D splits right and ⇧⌘D splits down, opening the next agent in
  the tree beside the one you're looking at. ⌘-click a row in the sidebar, or press ⌘↩ on an agent or project in Search
  ⌘K, to open it in a split. ⌃← and ⌃→ move between panes, and a click in a pane focuses it. ⌘W or a pane's × closes a
  split (with one pane left, ⌘W folds the project as before). Each project keeps its own splits. Rows shown in other
  panes are tinted in the sidebar. A split won't make a pane narrower than 340 pt: at 1440 pt three fit side by side.
- Desktop: **expand** a pane to the whole window with its arrows-out button or ⇧⌘↩. The sidebar hides, prose reads in a
  centred 800 pt column, code, tables, diffs and tool results get 1060 pt, and an ask sits at the foot at column width
  with its amber ring. Esc or arrows-in brings back exactly the panes you had, each where you left it. Picking another
  agent from ⌘K or ⌘J keeps the pane expanded. Search ⌘K lists Split right, Split down, Close this split, Expand / Collapse
  the pane and Show / Fold the sidebar, with their shortcuts.
- Desktop: project labels in the sidebar show their place icon (This Mac or boxd) for runs that didn't name a place too,
  using the daemon's default place.
- The app now finds the daemon the way the CLI does: `CAPCOMD_HARNESS_SOCKET`, then `$CAPCOMD_HOME/harness.sock`, then
  the app's `capcomd.socketPath` setting, then `~/.capcomd/harness.sock`.
