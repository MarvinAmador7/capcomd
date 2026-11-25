# CHANGELOG

- A question now shows where it was asked, at one state everywhere. In the thread of the agent it was asked of (and,
  once passed up, of the agent it went to) it is one line, "request limiter asked: Ship the limiter at 100 or 500
  req/min? · waiting on api lead", with **Answer**, which opens the question's card right there (your answer wins over
  the agent's). Once decided the line says so: "api lead answered 500 req/min — not the recommendation" with the note,
  "passed up to you", or "withdrawn". Click the asker's name to open its thread.
- A question passed up to you shows as its full card in the run's planner thread as well as in the asker's, in Needs
  you and in the menu bar. Answering it anywhere turns every place into the answered line at once, and all of it stays
  after the app or capcomd restarts.
- An agent whose conversation is rebuilt from its thread remembers the questions it was asked and what became of them
  ("agt-… asked you: …; you answered …").
- harness.v1 (capability `agents.ask`): besides the asker's, every agent a question reached has one `question` item for
  it in its thread (`itm-<agent>-asked-<qst>`): each agent it was asked of, an agent that answered it, and the asker's
  root agent once it is the user's. Its `question` is the same and moves with it (open, answered, withdrawn); its
  `text` names the asker ("agt-… asked: …"). This replaces the answering agent's separate copy (`itm-<agent>-answered-<qst>`).

# Spec

With the question's line in its addressee's thread: thread items of kind `question` in the threads of the agents a
question reached (id `itm-<agent>-asked-<qst>`, `asker` not the thread's agent), additive to harness.v1.
