#!/bin/sh
# Inside the recording container: a small repository at /work, the stub model server, and a `capcomd` only on an extra
# PATH directory (/tmp/xbin), as the in-VM capcomd is.
set -e
mkdir -p /tmp/xbin && printf '#!/bin/sh\necho capcomd-found\n' > /tmp/xbin/capcomd && chmod 755 /tmp/xbin/capcomd
rm -rf /work && mkdir -p /work && cd /work
git init -q
echo "# demo" > README.md
git -c user.email=a@b -c user.name=a add -A
git -c user.email=a@b -c user.name=a commit -qm init
if ! pgrep -f stub.mjs >/dev/null 2>&1; then nohup node /rec/stub.mjs > /out/stub.log 2>&1 & fi
sleep 1
echo ready
