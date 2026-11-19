# CHANGELOG

- When the engine is briefly overloaded and asks to be called again shortly ("overloaded … retry after N ms"), capcomd
  now waits that long and asks again (a few times, about two seconds at most) instead of failing the call: run reads,
  plugin services and other engine calls answer normally (an unknown run is still `not_found`) rather than with a
  spurious `unavailable` or engine error.
