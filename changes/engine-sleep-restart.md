# CHANGELOG

- capcomd no longer restarts after your Mac sleeps. Since 0.11.0 (Rivet 3.1.1) the engine stopped itself on every wake
  after a sleep longer than about 30 seconds, and `capcomd serve` exited with it ("engine on :6420 stopped answering")
  until launchd started it again. Now serve starts the engine again in place, on the same data, and logs one line
  ("the engine on :6420 exited …; starting it again on the same data"). The harness API stays open, and agents that
  were running when the Mac went to sleep carry on and finish.
