# CHANGELOG

- The watchdog now catches an agent that waits on a job that never ends. A job it started holds its clock for at most
  `plugins.watchdog.stalledAfterMs` (15 minutes by default), shared with the foreground commands it runs, between two
  signs of progress; after that the time counts, so an agent polling a stuck job (`capcomd job output` in a loop) gets
  the **stalled** notice about 30 minutes in, and is stopped at `stopAfterMs` as any other, instead of going unjudged
  until the job's own time limit ended it. The notice says which job: `; it has been waiting on job <id> for <time>`.
  A job that ends within the limit still doesn't count against the agent, and checks, approvals and usage-limit pauses
  still hold its clock as long as they last.

# Spec

The watchdog's job waits (§16.4, a fix from the live re-check): a job's hold on the agent's clock is bounded like a foreground command's: jobs and commands together hold it for at most `stalledAfterMs` between two signs of progress, after which the agent's quiet counts and `stalled` (then the stop) comes, so a worker polling a job that never ends is judged instead of waiting for the job's `afterTurnMs`. A verification, an approval or a pause still holds the clock as long as it lasts, and a job's or command's time while one does doesn't use up the `stalledAfterMs`. The notice and the stop's reason gain `; it has been waiting on job <id> for <time>` (the job waited on longest, timed from its start) while a job is still running. No hook, shape or config changes.
