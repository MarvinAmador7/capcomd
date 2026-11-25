# CHANGELOG

- New `GET /v1/events/wait`: a driver or the app can wait until something it cares about happens instead of polling.
  `type=` (event names such as `agent.done`, repeated or comma-separated), `agent=` (agent ids, the same way) and
  `wait=` (seconds, at most 45). It answers `{events, cursor, reached, timedOut}`: only the matching events, as soon as
  one is appended, or none when the wait runs out. Pass `cursor` back as `after` to resume: it moves past the events
  that didn't match and never past one that did. Example:
  `GET /v1/events/wait?scope=run-…&after=120&type=agent.done,agent.failed,agent.asked&agent=agt-…&wait=30`.
- A wait for an agent's state that it already reached before your cursor (`agent.done`, `agent.failed`,
  `agent.cancelled`, `agent.paused` or `agent.asked` with `agent=`) answers at once with `reached` (the agent, the
  state, and the event that put it there) instead of waiting for an event that already happened.
- `GET /v1/events` is unchanged. harness.v1 capability `events.wait`.
