# CHANGELOG

- What an agent hands back to its parent is now short and formatted. A worker's hand-back starts with its outcome in
  one line ("Done: added the Home section to the desktop page.") and follows with a few bullets: what changed, how it
  was checked, any risks, and anything you must decide. Leads and planners hand back the same way, with a bullet per
  child.
- A reviewer's hand-back now carries its verdict, **Approve** or **Changes needed**, with its findings as bullets
  (most severe first), instead of a bare "Finished.".
- A commit made from a hand-back like "Done: added X" gets the subject "Add X".
