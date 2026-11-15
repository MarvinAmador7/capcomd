# CHANGELOG

- A background job that capcomd stops because its agent ended no longer sends that agent a "your background job was
  stopped" message now and then. It could happen when the job's exit was seen at the moment the agent finished.
