# CHANGELOG

- capcomd now runs on Rivet 3.1.1 (rivetkit 3.1.1, with `@rivet-dev/services` 0.2.5).
- **Breaking:** a Rivet 3 engine can't read what the Rivet 2 engine kept, and capcomd doesn't carry it over. On the
  first `capcomd serve` after upgrading, the old engine data is moved aside to `~/.capcomd/engine/<port>/rivet-v2/`
  (nothing is deleted), serve prints one line saying so, and the engine starts empty: runs and agents from before the
  upgrade can't be shown, resumed or cancelled any more, and they leave the run list (kept in
  `~/.capcomd/state/runs-rivet-v2.jsonl`; their traces stay). Finish or cancel your runs before you upgrade.
- When you stop `capcomd serve` (Ctrl+C, SIGTERM, `capcomd service` stop), it now exits only once its engine and the
  rivet-services it started have stopped.
