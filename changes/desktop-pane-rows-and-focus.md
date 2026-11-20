# CHANGELOG

- Desktop: a split no longer leaves a pane blank: the pane that Split Down (⇧⌘D) halves shows its thread, also when that
  pane had been closed and opened again.
- Desktop: expanding a pane and coming back, or a split opening or closing beside it, keeps the same messages in view.
  It used to keep the distance from the end of the thread, which could drift by a message on each expand and collapse.
  A thread you were following at the end still stays at the end.
- Desktop: after Expand Pane (⇧⌘↩) the keyboard is in the expanded pane (its message box if you were typing there), and
  collapsing gives it back to where it was before.
- Desktop: collapsing an expanded pane with Esc is instant, as ⇧⌘↩ is; clicking the pane's buttons still animates.
