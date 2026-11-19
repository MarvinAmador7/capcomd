# CHANGELOG

- A background job (`capcomd job start`, a plugin's `ctx.jobs`) whose runner can't start in its machine now fails as
  soon as the runner is gone, instead of after waiting 5 s for it.
- With no engine running, the commands that read a run's repository settings (the context brief, memory and secret
  scan for a run) no longer wait 3 s for an answer that can't come.
