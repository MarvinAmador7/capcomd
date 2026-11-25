# CHANGELOG

- An answered question keeps its line after the desktop app reconnects or restarts (and after capcomd restarts):
  "Answered · 100 req/min · 11:42", with "not the recommended" when so and the answerer's note, in the asker's thread
  (other agents' threads show the question's own line: see question-card-parent). A withdrawn question (its agent was
  cancelled) now reads "Withdrawn" instead of vanishing.
- An agent whose conversation is rebuilt from its thread (when its saved session can't be resumed) still knows what it
  asked and what was answered.
- harness.v1 (capability `agents.ask`): thread items of the new kind `question` (additive; clients render an unknown
  kind as its `text`). The asker's thread has one per question, a new rev when it is passed up, answered or withdrawn
  (every other agent it reached has its own item for it: see question-card-parent). Its `question` field carries the question, its options, who it is asked of,
  its state (`open`, `answered`, `withdrawn`), the answer, `recommended`, who answered, their note and when.

# Spec

With answered questions in the thread: thread item kind `question` with the optional `question` field (questionId, asker, state, the question and its options, to, passedBy, answer, recommended, by, note, replaces, reason, askedAt, decidedAt), written to the asker's thread (and the threads of the agents it reached: question-card-parent); additive to harness.v1.
