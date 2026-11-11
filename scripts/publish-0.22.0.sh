#!/usr/bin/env bash
# The npm publishes for Open Exchange 0.22.0, IN ORDER. For David, from his own terminal (npm login first; each
# `npm publish` asks for the OTP). Nothing here is run by an agent. Each step names the checkout and tag it publishes.
#
#   0. Before: skein `events-own-step` merged and tagged v0.8.0; skein-1color v0.19.0 and skein-amm v0.50.0 tagged;
#      open-exchange release-0.22 pinned on them (build.zig.zon, image/token, image/discovery, www.sh, package.json)
#      and tagged v0.22.0 after its acceptance passes.
#   1. @dcasegr/skein 0.8.0        a clean skein checkout at v0.8.0 (prepack builds dist/ and the kernel wasm)
#   2. @dcasegr/amm-engine 0.50.0  skein-amm v0.50.0 web/engine
#   3. @dcasegr/amm-client 0.50.0  skein-amm v0.50.0 web/client. THE 0.21 LESSON: web/client has NO lock and builds
#      from web/ui's sources — `npm ci` in web/ui and in web/engine first, then `npm install` + publish in web/client
#      (needs 2 on the registry).
#   4. open-exchange: the lock regenerated against the registry, committed, re-tagged if it changed, then published
#      (prepack builds dist/)
set -euo pipefail
W="${W:-$HOME/Work/agent-env}"
SKEIN_TAG=v0.8.0; AMM_TAG=v0.50.0; OX_TAG=v0.22.0
SKEIN_V=0.8.0; AMM_V=0.50.0; OX_V=0.22.0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
wait_registry() { for i in $(seq 1 60); do [ "$(npm view "$1@$2" version 2>/dev/null)" = "$2" ] && return 0; sleep 5; done; echo "$1@$2 not on the registry" >&2; exit 1; }
check_pack() { (cd "$1" && npm pack --dry-run --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"))[0]; console.log(j.name, j.version, j.files.length, "files")'); }

# 1
git -C "$W/skein" fetch -q --tags
git -C "$W/skein" worktree add --detach "$tmp/skein" "$SKEIN_TAG"
(cd "$tmp/skein" && npm ci && check_pack . && npm publish)
wait_registry @dcasegr/skein "$SKEIN_V"

# 2, 3
git -C "$W/skein-amm" fetch -q --tags
git -C "$W/skein-amm" worktree add --detach "$tmp/amm" "$AMM_TAG"
(cd "$tmp/amm/web/engine" && npm ci && check_pack . && npm publish)
wait_registry @dcasegr/amm-engine "$AMM_V"
(cd "$tmp/amm/web/ui" && npm ci)
(cd "$tmp/amm/web/client" && npm install --no-audit --no-fund && check_pack . && npm publish)
wait_registry @dcasegr/amm-client "$AMM_V"

# 4
OX="$W/open-exchange"
git -C "$OX" fetch -q --tags
git -C "$OX" worktree add --detach "$tmp/ox" "$OX_TAG"
(cd "$tmp/ox" && rm -rf node_modules && npm install --no-audit --no-fund && git diff --quiet package-lock.json || { echo "package-lock.json changed against the registry: commit it on release-0.22 and re-tag before publishing" >&2; exit 1; })
(cd "$tmp/ox" && check_pack . && npm publish)
wait_registry open-exchange "$OX_V"
git -C "$W/skein" worktree remove --force "$tmp/skein"; git -C "$W/skein-amm" worktree remove --force "$tmp/amm"; git -C "$OX" worktree remove --force "$tmp/ox"
echo "published: @dcasegr/skein $SKEIN_V, @dcasegr/amm-engine $AMM_V, @dcasegr/amm-client $AMM_V, open-exchange $OX_V"
