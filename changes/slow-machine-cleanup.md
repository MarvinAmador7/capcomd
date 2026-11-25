# CHANGELOG

- An agent whose machine took longer than 90 seconds to start no longer leaves that machine running after it ends:
  it is deleted (or parked, for a planner or lead) like any other. Before, it kept running until its idle lifetime ran
  out (an hour by default).
