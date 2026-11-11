# CHANGELOG

- Fixed: a fresh install (`bun add -g capcomd`, `npm install -g capcomd`) couldn't start runs. `capcomd serve` printed
  `actors not ready yet (RivetKit registry did not register with the Engine …)` and `Services did not register in pool
  'services'`, and every `capcomd run new` failed. A newer release of one of the engine's dependencies
  (`@rivet-dev/services` 0.2.5) didn't work with capcomd's engine. capcomd now pins the version that does, so fresh
  installs start runs again. If yours is broken, upgrade capcomd and restart `capcomd serve` (or the service).
