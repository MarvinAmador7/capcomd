# CHANGELOG

- `GET /v1/events/wait` answers as soon as a matching event happens: the daemon is told of each new event instead of
  checking for them twice a second.
