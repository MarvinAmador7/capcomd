# CHANGELOG

- The desktop app's agent thread is calmer and easier to scan. Each tool call is one grey line: its icon, the tool's
  name, what it was about, and on the right a spinner while it runs, a blue tick when it's done, "Failed", or "Not
  allowed". Only that word and its icon are coloured; the line itself no longer turns red.
- Tool calls in a row fold into one line, "Used 3 tools · 5.0s", with their icons stacked. A group that holds a refused
  or failed call says so in words ("Used 3 tools · 3 not allowed · 41s"). Click the line to see each call, and a call
  to see its arguments and result. A call that is still running stays on its own line until it finishes.
- Back-to-back thinking shows as one line with the total time, "Thinking · 5s". While the agent thinks, its bot
  twinkles beside "Thinking" and the seconds count up. "Hidden by the CLI" moved inside the line: open it to see why
  there is no text.
- Hand-back cards are lighter: the agent's bot, its name and "worker · handed back", a summary that fades out after a
  few lines with Show more. A reviewer's card shows a small green seal and "Passed review" (or a red one and "Didn't
  pass review") with its reasons as a list.
- The pane header's title is no longer bold, the agent's id and clock use even-width figures, and while the agent works
  its bot twinkles and "working" shimmers. With Reduce Motion on, nothing moves.
