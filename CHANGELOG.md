# Changelog

Released versions of open-exchange on the 0.27 line from 0.27.2. Earlier releases are described by their
release commits and tags (`git log`, `git tag -n`).

## Unreleased

- The live-update streams (`GET <origin>/amm/events`, `GET /@<token>/amm/events`) send an SSE comment
  (`: connected`) at once after the headers and a comment keep-alive (`: keep-alive`) every 15 s while the
  connection is open; the timer is cleared when it closes. Behind a proxy that passes the headers on only with
  the first body byte (a Cloudflare tunnel), a stream with no trading activity got no headers and was ended by
  the proxy's 524 after ~100 s, without CORS headers. Event payloads are unchanged; EventSource ignores comments.

## 0.27.2 (npm tag `latest`)

- The host's analytics store: the swap data the host derives from each token instance's `amm/hop`
  events (trades, candles, stats, the pool listings and their lifetime counters, `/pools/at`,
  `/pools/history`) is in its own SQLite file, `$SKEIN_HOME/analytics.sqlite` (beside host.db and
  store.sqlite), and every read is a query on it; nothing about swaps is held in memory. The store
  keeps, per token instance, the last event place it took (written in the same transaction as the
  rows), so a start follows each instance from after that place instead of replaying from place zero.
  Every read keeps its path, JSON, order and cursors.
- `GET <origin>/amm/lp/fees?pool=<poolId>,…&from=<ms>&to=<ms>`: the LP fees of the named pools' swaps
  (`from` ≤ at < `to`, both optional), a buy's `feeLp` in sats, a sell's in the pool's token:
  `{from, to, sats, tokens: [{tokenId, amount}], swaps, pools, byPool: [{poolId, tokenId, sats, tokens,
  swaps}]}`, amounts as decimal strings. In the OpenAPI document (H10) and the skill's route table.
- The client call beside it: `@dcasegr/amm-client` 0.54.2's `lpFees(poolIds, {from?, to?})` (amounts as
  bigints), in the skill. Package on @dcasegr/amm-engine 0.54.2 (engine code unchanged); the swap pages
  rebuilt from skein-amm v0.54.2's web/ui (www.sh AMM_TAG v0.54.1 → v0.54.2); the skill, its examples and
  wallet-headless.md on amm-engine / amm-client 0.54.2. The token image and host/pool-code.ts stay as
  0.27.1 has them (token app skein-amm v0.52.1); swap app 0.27.2.
- skein-amm 0.54.2's web (pages and client) on `@bopen-io/color-permission-module` 0.2.3 and `@1sat/actions`
  0.1.6, as the 0.28 line; the skill, its examples and wallet-headless.md name those pins.
- The same change as 0.28.1, on the 0.27 line.

Upgrading from 0.27.1: npm install and restart; the first start builds analytics.sqlite from each
instance's events. Published under the npm dist-tag `latest`; the 0.28 line is under `next`.
