#!/usr/bin/env bash
# Open Exchange 0.22.0: a CLEAN RELAUNCH (fresh homes REQUIRED: chain state shape 2 and the event index format 11 refuse older homes) of one host (G3, settled: no old↔new sync; the host moved aside and started
# clean, the admin reconfigures, each token's mined history loaded through the new door). Run ON the host, by hand,
# after scripts/publish-0.22.0.sh has put every package on the registry. ORDER: ovh first, then the rack.
#
#   bash relaunch-0.22.0.sh ovh     # testnet.openex.dev: install ~/ox-testnet, home ~/ox-testnet/home, pm2 openex-testnet
#   bash relaunch-0.22.0.sh rack    # swap.skein.nexus:   install ~/ox,         home ~/.skein,           pm2 open-exchange
#
# What it does, in order (it stops at the first failure):
#   1. checks: node >= 24, pm2, the pm2 app exists, the home holds key + host.env;
#   2. installs open-exchange@$VERSION into the install dir (npm install; the registry's packages only);
#   3. refuses the package if an image still names a local app tree (the signer and wallet apps must be {url, hash}
#      tarballs by then: image/<swap|token>/etc/apps.json);
#   4. stops the pm2 app and waits for its kernel to exit;
#   5. moves the home aside (<home>.old-<stamp>) and makes a fresh one with ONLY: key, operator.key, host.env,
#      teranode-peers.json (same keys, same peer id, same settings); the rack's host.env must keep
#      SKEIN_MANAGER_FOR=swap and SKEIN_ROOT_INSTANCE=swap (checked);
#   6. starts the pm2 app; waits for `open-exchange: swap's events wired` in its log (the first run makes swap and
#      discovery, owned by the host's key); then reads /, /amm/tokens, /amm/discovery, /.well-known/skein (unclaimed).
# Then, by hand: the admin claims swap on Settings, sets the defaults FIRST, the listing price, discovery on, enables
# the tokens; then load-history.mjs per token (plans/deploy-0.21/README.md (cursors and event ids are three-part since skein 0.8.0)), then discovery's deploys (--discovery).
set -euo pipefail
case "${1:-}" in
  ovh)  DIR="$HOME/ox-testnet"; HOMEDIR="$HOME/ox-testnet/home"; APP=openex-testnet; ORIGIN=https://testnet.openex.dev ;;
  rack) DIR="$HOME/ox";         HOMEDIR="$HOME/.skein";          APP=open-exchange;  ORIGIN=https://swap.skein.nexus ;;
  *) echo "usage: $0 ovh|rack" >&2; exit 2 ;;
esac
VERSION=0.22.0
say() { printf '[relaunch %s] %s\n' "$1" "$2"; }
fail() { say "$1" "STOP: $2" >&2; exit 1; }

# 1
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail 1 "node >= 24 needed ($(node -v))"
command -v pm2 >/dev/null || fail 1 "no pm2"
pm2 describe "$APP" >/dev/null 2>&1 || fail 1 "no pm2 app $APP"
for f in key host.env; do [ -e "$HOMEDIR/$f" ] || fail 1 "$HOMEDIR/$f missing"; done
if [ "$1" = rack ]; then
  grep -q '^SKEIN_MANAGER_FOR=swap' "$HOMEDIR/host.env" || fail 1 "the rack's host.env lacks SKEIN_MANAGER_FOR=swap (the exchange's handle equals the router's own label)"
  grep -q '^SKEIN_ROOT_INSTANCE=swap' "$HOMEDIR/host.env" || fail 1 "the rack's host.env lacks SKEIN_ROOT_INSTANCE=swap"
fi
say 1 "checks ok ($DIR, $HOMEDIR, pm2 $APP, $ORIGIN)"

# 2
( cd "$DIR" && npm install --no-audit --no-fund "open-exchange@$VERSION" )
PKG="$DIR/node_modules/open-exchange"
have="$(node -p "require('$PKG/package.json').version")"
[ "$have" = "$VERSION" ] || fail 2 "installed open-exchange $have, not $VERSION"
say 2 "open-exchange $have installed (skein $(node -p "require('$DIR/node_modules/@dcasegr/skein/package.json').version"), amm-engine $(node -p "require('$DIR/node_modules/@dcasegr/amm-engine/package.json').version"))"

# 3
for img in swap token discovery; do
  node -e '
    const a = require(process.argv[1]).install;
    const local = a.filter((e) => typeof e === "string" && e !== "../../apps/swap");
    if (local.length) { console.error(`image ${process.argv[2]}: local app trees ${local.join(", ")}`); process.exit(1); }
  ' "$PKG/image/$img/etc/apps.json" "$img" || fail 3 "the package's image $img names a local app tree: not deployable"
done
say 3 "images name tarballs only"

# 4
pm2 stop "$APP" >/dev/null
for i in $(seq 1 60); do pgrep -f "[s]kein-kernel.*$HOMEDIR" >/dev/null || break; sleep 1; done
pgrep -f "[s]kein-kernel.*$HOMEDIR" >/dev/null && fail 4 "a kernel still holds $HOMEDIR"
say 4 "$APP stopped"

# 5
STAMP="$(date -u +%Y%m%d%H%M)"
OLD="$HOMEDIR.old-$STAMP"
mv "$HOMEDIR" "$OLD"
mkdir -m 700 "$HOMEDIR"
for f in key operator.key host.env teranode-peers.json; do [ -e "$OLD/$f" ] && cp -p "$OLD/$f" "$HOMEDIR/$f"; done
say 5 "old home at $OLD; fresh home with $(ls "$HOMEDIR" | tr '\n' ' ')"

# 6
LOG="$(pm2 describe "$APP" | sed -n 's/.*out log path[^/]*\(\/[^ ]*\).*/\1/p' | head -1)"
START_LINES=$( [ -n "$LOG" ] && wc -l < "$LOG" || echo 0 )
pm2 restart "$APP" --update-env >/dev/null
say 6 "$APP started; waiting for swap's events (up to 10 min: the first run makes swap and discovery)"
for i in $(seq 1 600); do
  if [ -n "$LOG" ] && tail -n +"$((START_LINES + 1))" "$LOG" | grep -q "open-exchange: swap's events wired"; then break; fi
  sleep 1
done
[ -n "$LOG" ] && tail -n +"$((START_LINES + 1))" "$LOG" | grep -q "open-exchange: swap's events wired" || fail 6 "no 'swap's events wired' line in $LOG"
for p in / /amm/tokens /amm/discovery /.well-known/skein; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN$p"); say 6 "GET $p → $code"
done
say 6 "card: $(curl -s "$ORIGIN/.well-known/skein")"
say done "relaunched on $VERSION. Next (by hand): claim swap, defaults FIRST, price, discovery on, tokens; then load-history.mjs per token."
