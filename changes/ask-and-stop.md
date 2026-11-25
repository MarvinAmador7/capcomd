# CHANGELOG

- Agents ask instead of guessing or waiting. An agent that needs a decision runs `capcomd ask "<question>" --recommend
  "<answer>" [--option "<other>"]… [--why "<one line>"] [--holds "<what waits on it>"]` (`capcomd_ask` as an MCP tool in
  its VM) and its turn ends: its work is saved, it frees its slot and its machine parks or goes, exactly as when it is
  idle. It shows as **asked** until someone answers.
- The question goes to the agent's parent, or to you when a root agent asks. A parent waiting with `await --wake` is
  woken by it (a blocking `await` returns with `asked`), and answers with `capcomd answer <qst|agt> "<answer>" [--note
  "why"]`, `--recommended` to take the recommendation, or `--up` to pass it to its own parent (you, at the root) when
  it isn't its to decide. You can always answer, in the app or by sending the agent a message: a plain message to an
  asked agent is its answer, and your answer wins over an agent's. Either way the answer continues the same
  conversation. A cancelled agent's question is withdrawn.
- The desktop app shows a question as a card in the asker's thread: numbered options with keys, the
  advised one marked Recommended with the agent's reason under it, what waits on it, and Answer; once answered it
  becomes one line ("Answered · 100 req/min · 11:42", saying when it wasn't the recommendation and keeping your note).
  Asked agents read "asked" in the sidebar, the tree and the columns, and the message box of an asked agent sends the
  answer.
- Recurring check-ins: `capcomd wake --every 30m [--times N] [--note "…"]` (`every`/`times` on `capcomd_wake`) books a
  schedule. A check-in outlives the agent's turn: one that comes while the agent is idle starts its next turn. A
  check-in missed while capcomd was down is skipped, not delivered late, and a schedule ends when its agent is cancelled
  or its run archived. `capcomd wake --cancel <wk>` ends it sooner.
- harness.v1 (capability `agents.ask`): `Agent.asked` (the open question: options, recommendation, reason, what waits
  on it, who it's asked of); events `agent.asked`, `agent.answered`, `agent.question_passed` and
  `agent.question_withdrawn` on run streams and the lifecycle feed (causes `asked`, `answered`, `passed_up`,
  `withdrawn`); approvals of kind `question` (subject `questionId`, `options`, `recommend`, `why`, `holds`, `to`,
  `passedBy`) answered with `POST /v1/approvals/{id}/decision` `{decision: "answer", answer, reason}` (or `approve` for
  the recommendation), status `answered` with `answer` and `recommended`; `agent.wake_armed` `every`/`times`,
  `agent.woken` `slot`/`skipped`, and `agent.wake_cancelled` reason `archived`.

# Spec

With ask and stop (ADR-026 §4): `ApprovalKind` gains `question` and `ApprovalStatus` `answered`; `Decision` gains the optional `answer` and `recommended` (a question's), all additive.
