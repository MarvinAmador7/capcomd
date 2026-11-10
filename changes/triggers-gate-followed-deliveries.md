# CHANGELOG

- Fixed: on a thread a working run follows, such as a goal's pull request on a public repository, a comment now reaches
  the run's planner only when its author is in `triggers.sources.<source>.allowed` (or the thread matches an `opened`
  pattern). Before, anyone's comment was handed to the working planner, so a stranger could steer it. Anyone else's
  comment is not delivered; `capcomd triggers log` shows it as `denied by allowlist: …: not delivered to run-…`,
  and the `trigger.received` event carries `decision: denied` with that run's `runId`. Bots and CI reach a working
  run only when allowed too. To let someone comment on your runs' pull requests, add them to `allowed`.

# Spec

Deliveries to a live run on a followed thread need an allowed actor (§16.3.2 step 2, §16.3.6's goal pull request row; found in the finishing pass: every goal pull request's thread is followed, and on a public repository anyone's comment reached the working planner): on a live run, step 2 delivers only when step 3's gate allows the trigger (its actor in `allowed`, or its thread matching an `opened` pattern; bots and CI too), still asking neither `trigger.admitting` nor the mode; anyone else's is recorded and not delivered, `denied {by: "allowlist", reason, wouldHave: "continue", runId}` (the dedupe mark stays), unless an ended run following the same thread takes it in its inbox. `TriggerDecision`'s `denied` gains optional `wouldHave: "continue"` and `runId` (additive), and `trigger.received` carries that `runId`. Ended runs are unchanged (a person's trigger lands in the inbox; the gate decides a restart). No hook, seam, route or config changes.
