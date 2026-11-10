#!/bin/sh
# Runs each bridge scenario named on the command line (each in a fresh copy of /work).
for n in "$@"; do
  sh /rec/setup.sh >/dev/null
  node /rec/drive.mjs /rec/b-$n.json
  echo "$n: $(tail -1 /out/$n.bridge.err)"
  ls /work > /out/$n.work.txt
done
