# CHANGELOG

- A question now shows where it was asked, at one state everywhere, with one full card per question: where the
  decision is owed. Asked of an agent, the asker's thread has the card and the thread of the agent it was asked of (and,
  once passed up, of the agent it went to) has one line, "request limiter asked: Ship the limiter at 100 or 500 req/min?
  · waiting on api lead", with **Answer**, which opens the question's card right there (your answer wins over the
  agent's). The line is one row where there's room (an opened pane) and two in a narrow column; a cut question shows
  whole on hover. Once decided it says so: "api lead answered 500 req/min — not the recommendation" with the note, or
  "passed up to you". Click the asker's name to open its thread.
- A question passed up to you is its full card in the run's planner thread, in Needs you and in the menu bar; the
  asker's own thread shows the line "asked you" with Answer instead of a second card. Answering it anywhere turns every
  place into the answered line at once, and all of it stays after the app or capcomd restarts.
- A withdrawn question (its agent was cancelled) is one quiet line, "Withdrawn · Which limit? · 11:42"; hover it for
  why.
- The message capcomd sends to deliver a question (or to word an answer) no longer shows in the thread: the question's
  line says it. Show Bookkeeping shows it.
- An agent whose conversation is rebuilt from its thread remembers the questions it was asked and what became of them
  ("agt-… asked you: …; you answered …").
- harness.v1 (capability `agents.ask`): besides the asker's, every agent a question reached has one `question` item for
  it in its thread (`itm-<agent>-asked-<qst>`): each agent it was asked of, an agent that answered it, and the asker's
  root agent once it is the user's. Its `question` is the same and moves with it (open, answered, withdrawn); its
  `text` names the asker ("agt-… asked: …"). This replaces the answering agent's separate copy
  (`itm-<agent>-answered-<qst>`). The messages capcomd writes to deliver a question or word an answer carry
  `internal: true` (message.sent, Message in GET …/messages and snapshot.threads); a rebuilt conversation leaves them
  out.

# Spec

With the question's line in its addressee's thread: thread items of kind `question` in the threads of the agents a
question reached (id `itm-<agent>-asked-<qst>`, `asker` not the thread's agent), and the optional `internal` on
message.sent and Message (a question's delivery, an answer worded by capcomd), additive to harness.v1.
