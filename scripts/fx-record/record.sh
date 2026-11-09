#!/bin/sh
# Records tests/agents/fixtures/fx from the pinned fx itself (src/plugins/agent-fx.ts FX_VERSION), without running fx on
# this machine and without a model: the release archive for Docker's architecture is downloaded and checked against
# capcomd's sha256, then fx runs only inside a throwaway container with no network (`--network none`), against a
# scripted OpenAI-compatible model server (stub.mjs) in that container. Each scenario (bscen.mjs) runs capcomd's bridge
# (src/plugins/fx-bridge.mjs) as the supervisor would (drive.mjs), with a tap between it and fx (fxtap.mjs): the tap's
# record is <name>.acp.jsonl (what fake-fx.mjs replays), the bridge's output <name>.bridge.jsonl (what the provider's
# parse reads). The container is removed at the end. Run after bumping FX_VERSION, and review the fixtures' diff.
#   scripts/fx-record/record.sh [scenario…]      (default: all)    FX_RECORD_IMAGE: an image with node (node:22-bookworm)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
image=${FX_RECORD_IMAGE:-node:22-bookworm}
work=$(mktemp -d)
name="capcomd-fx-record-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT INT TERM

case "$(docker info --format '{{.Architecture}}')" in x86_64|amd64) arch=x86_64;; aarch64|arm64) arch=aarch64;; *) echo "unsupported Docker architecture" >&2; exit 1;; esac
eval "$(cd "$root" && bun -e "import { FX_RELEASE } from './src/plugins/agent-fx.ts'; const a = FX_RELEASE.assets['$arch']; console.log('url=' + a.url + '; sum=' + a.sha256)")"
mkdir -p "$work/dl" "$work/bin" "$work/rec" "$work/out"
curl -fsSL "$url" -o "$work/dl/fx.tgz"
got=$(shasum -a 256 "$work/dl/fx.tgz" | cut -d' ' -f1)
[ "$got" = "$sum" ] || { echo "fx archive sha256 is $got, not $sum: not used" >&2; exit 1; }
tar -xzf "$work/dl/fx.tgz" -C "$work/bin" fx
cp "$here"/*.mjs "$here"/*.sh "$work/rec/"
cp "$root/src/plugins/fx-bridge.mjs" "$work/rec/fx-bridge.mjs"
chmod 755 "$work/rec/fxtap.mjs"
(cd "$root" && bun -e "import { fxOrchestrateRules } from './src/plugins/agent-fx.ts'; import { ORCHESTRATE_DENIED_COMMANDS } from './src/plugins/agent-common.ts'; await Bun.write('$work/rec/orchestrate-rules.json', JSON.stringify(fxOrchestrateRules(ORCHESTRATE_DENIED_COMMANDS)))")

docker run -d --rm --name "$name" --network none -v "$work/bin:/opt/fx:ro" -v "$work/rec:/rec" -v "$work/out:/out" "$image" sleep 3600 >/dev/null
docker exec "$name" node /rec/bscen.mjs >/dev/null
scenarios=${*:-plain shell failing edit steer followup auth credits ratelimit steps orchestrate mcp kill path noauth}
docker exec "$name" sh /rec/ball.sh $scenarios
for n in $scenarios; do
  cp "$work/out/$n.tap.jsonl" "$root/tests/agents/fixtures/fx/$n.acp.jsonl"
  cp "$work/out/$n.bridge.jsonl" "$root/tests/agents/fixtures/fx/$n.bridge.jsonl"
done
echo "recorded: $scenarios"
