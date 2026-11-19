# CHANGELOG

- A reviewer's card in its planner's thread now shows its verdict (a green "Passed review" or red "Didn't pass review"
  seal) and its reasons, as the reviewer's own thread does, instead of "Finished.". A reviewer that ended without a
  verdict says "Finished without a verdict.". Thread items gain `child.verdict` (`{passed, reasons}`) on a reviewer's
  hand-back.
- Hand-back cards render the child's summary as formatted text (lists, code, paragraphs). A long summary is clamped to
  about eight lines with Show more, and its text can be selected; the card's header still opens the child's thread.
- Agent threads no longer show Claude Code's bookkeeping as raw lines ("System: thinking_tokens" and the like). A tool
  call that Claude Code's permission rules refused says "Not allowed" on its own red row instead of a separate
  "System: permission_denied" line. Model-request retries and fallbacks are said in plain words. Threads recorded by
  an older daemon hide those lines too.
- In the desktop window, an agent's pane centres its thread in a wide window, and the message box under it keeps to
  the same column.
- The pane header no longer repeats the run's title next to the place and clock (the sidebar shows it just above).
  Hover the agent's title to see the run's goal.
