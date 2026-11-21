# CHANGELOG

- `GET /v1/events` can filter and wait, so a driver or the app can block until something it cares about happens
  instead of polling: `type=` (event names such as `agent.done`, repeated or comma-separated), `agent=` (agent ids, the
  same way) and `wait=` (seconds, at most 45). With any of them the answer is `{events, cursor, reached, timedOut}`:
  only the matching events, answered as soon as one is appended, or none when the wait runs out. Pass `cursor` back
  as `after` to resume: it moves past the events that didn't match and never past one that did. Example:
  `GET /v1/events?scope=run-…&after=120&type=agent.done,agent.failed,agent.asked&agent=agt-…&wait=30`.
- A wait for an agent's state that it already reached before your cursor (`agent.done`, `agent.failed`,
  `agent.cancelled`, `agent.paused` or `agent.asked` with `agent=`) answers at once with `reached` (the agent, the
  state, and the event that put it there) instead of waiting for an event that already happened.
- Without `type`, `agent` or `wait`, `GET /v1/events` answers the plain list as before. harness.v1 capability
  `events.wait`.
