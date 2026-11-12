# Open Exchange

The Open Exchange is a distributable application host for 1Color token swaps. It runs on
[skein](https://github.com/shruggr/skein)'s host, used as a library. The AMM itself is a
library, [skein-amm](https://github.com/shruggr/skein-amm): the token app, its programs and
the page library. Open Exchange adds the host program, the `swap` app and the images.

## Run it

```
npx open-exchange
```

Then open http://127.0.0.1:8100, connect your wallet (Yours) and claim the exchange on Settings.

Nothing needs setting. The first start takes a few minutes: it syncs the block headers. The design is in shruggr/open-exchange#1 and shruggr/skein#164.

The public read API is documented at `<origin>/api/` (the reference page) and `<origin>/api/openapi.json` (OpenAPI 3.1; sources in `api/`, copied into the pages by `scripts/www.sh`).

The read API's routes, plain GETs, and the pool event feeds (0.14.0: every pool read by the pool id — the deploy outpoint `<txid>_<vout>`, a clean break, no `?lp=`; one price; the validator's minimum leg; the pools route no longer streams):

| route | answer |
|---|---|
| `/amm/pools` | every enabled token's live pools, one array (a plain read) |
| `/amm/stats` (`?ids=`) | every enabled token's `/stats` as the host answers it, one array (the landing page reads it once per load and every 30 s while visible) |
| `/amm/positions?pool=` | every enabled token's positions for the pool ids, each with its `tokenId` |
| `/amm/spends?outpoint=a,b` | one record per outpoint, `{outpoint, tokenId?, spentBy?}`: each enabled token's `/spends`, the first that names a spender |
| `/amm/events` | Server-Sent Events, every enabled token's pool events: `event: pool`, `data: {tokenId, …row}` — the token instance's lookup's row as it admits a deploy, swap, close or rescind (or a `revert` of a rejected one), passed through; nothing on connect, nothing kept, nothing replayed |
| `/@<token>/amm/events` | the same feed for one token |
| `/@<token>/amm/pools` | the token's live pools (each with `poolId`, `lpPubKey`, `swaps`, and 0.19.0 `lifetime`: the pool's counters — volume in and out each side, the fees to the LP, validator and commission in each asset, the last trade's time), its market, the validators beating (each with `minLegSats` when its beat's terms carry one); a plain read only |
| `/@<token>/amm/pools/at?t=` | every pool listed at a time, as it stood then: each pool's events in event order up to its first with `at > t` |
| `/@<token>/amm/pools/history` (`?from&to&pool&limit&after`) | the raw pool history (deploy, swap, close, rescind), oldest first in event order, `from`/`to` on each row's own `at`, paged forward by `next` |
| `/@<token>/amm/trades` (`?from&to&limit&before&pool`, or `?txid=`) | the token's trade rows, newest first in EVENT order (the order the instance recorded them; never re-sorted by time), each with `poolId` and `payoutPkh`; `from`/`to` filter each row's own `at`; `before` = an event place (a page's `next`), 0.25.0: an older cursor is refused 400. A hop's `at` is its block's time when it was recorded already mined, else the step's, never changed afterwards (skein-amm 0.52.0) |
| `/@<token>/amm/candles?tf&from&to` (`&series=fill`) | one candle per non-empty bucket of trades, from the host's per-minute tallies kept as each trade arrives (open and close within a minute in arrival order); 0.25.0: `series=market` removed (400) |
| `/@<token>/amm/stats` | the host's (0.19.0: with the instance's lifetime `volumeSats`, `volumeTokens`, `trades`; 0.20.0: the instance's row is the last fill, the volumes and the counts only, the rest the host's, the fields as before): `price` = the planner's `priceOf` over the pools `/@<token>/amm/pools` lists (the midpoint of what a buy and a sell of 1% of the pooled sats would pay now), `buyPrice`, `sellPrice`; `change1h` / `change24h` from the same price over the pools listed then (`/pools/at`); `lastTradePrice` and last trade = the last swap event, 24 h volume and counts (from the minute tallies); TVL and pools over the listed pools |
| `/@<token>/amm/color/<token>/holders` (`?limit&skip`) | the holder count and the balances, largest first; 0.19.0 (skein-1color 0.17.0): `supply`, `authorities`, `burned`, `burns` beside them |
| `/@<token>/amm/positions?pool=` | by pool id (0.14.0); 0.19.0: `/pools/beef` is gone — a pool's transaction is `/tx?id=` of its current outpoint's txid |
| `/@<token>/amm/fees/validator`, `/fees/commission`, `/terms` (the validator's `minLegSats`), `/spends`, `/tx`, `/token` | as before (0.11.0; 0.17.0: no swap records, so no swap read; 0.17.1: `/tx` carried every input's source transaction; 0.17.2: reverted, `/tx` as 0.17.0; 0.19.0: `/spends` answers `{outpoint, spentBy?}`, one lookup, no pool following) |
| `POST /@<token>/amm/swap` (0.17.0) | the swap relay, the HOST's: body `{funding, swap, pool, validator, peerId}` (DAG-JSON bytes) → the validator's reply as it is (`{ok: true, tx, txid, beef?}` / `{ok: false, reason, detail?, pool?, beef?}`), or `{ok: false, reason: "commission_missing"}` (the one rule the host checks: the commission pays this exchange's key) or `{ok: false, reason: "unreachable", detail}` (any break in the call); 0.23.0: a reply carrying the signed swap (`tx`) is answered when THIS host's broadcast of it is taken by Arcade (a relayed reply's BEEF taken into the token instance first, which this host then broadcasts; on the validator's own host skein holds the frame's answer the same way), and `{ok: false, reason: "rejected", detail: <Arcade's reason>}` if Arcade refuses it as invalid; a refusal (no `tx`) at once; plain; nothing recorded; the request's close stops the host (host/relay.ts) |
| `/amm/tokens`, `/@discovery/1color/tokens` (rows with `amount` and `height`), `/<token>`, `/<token>/icon`, `/<token>/deploy` | as before |
| `/@discovery/1color/tokens?q=<text>&after=<tokenId>&limit=` (0.15.1) | search: the tokens whose `sym` starts with `q` (ASCII case-insensitive) or whose `tokenId` starts with it, the same rows and order; `after` = the rows strictly after that token (the last row's id; the answer stays the plain array); an unknown `after`, `after` beside `skip`, `q`/`after` beside `ids` → 400; tokens deployed before 0.15.1 are found by id only until their deploy is admitted again |

## The shape

- **swap**: the instance that serves the Swap, Liquidity, Your tokens and Settings pages.
  - It records the admin's decisions as facts under its own heads.
  - It emits each fact as an event.
  - It asks nothing of anyone, and nothing answers back.
  - The first run makes it, born owned by the host's key (root): the host can always update its
    pages. The first wallet to claim it (Settings: "Claim this exchange") becomes its ADMIN:
    the host grants it the role `amm.admin`, which configures and enables; it is not root.
    Someone else got there first: start again in a fresh `SKEIN_HOME`.
- **The host** (`open-exchange`, the same as `open-exchange run`): skein's host, `skein-host run`, plus its wiring for
  swap's events.
- **The token instances**: one per enabled token, at `<origin>/@<tokenId>`.
  - Each comes from the image `token`, which installs skein-amm's token app.
  - Each is born owned by the host's key: no claim.
  - Each takes its deploy BEEF as an event on the token app's route.
- **discovery**: the 1Color discovery topic `tm_color` and its lookup `ls_color`.
  - It comes from the image `discovery`, which installs skein-1color.
  - The first run makes it, born owned by the host's key: no claim.
  - The Settings switch only starts and stops it.

## The events (swap's app `amm`, box `amm/admin`, the admin's or root's messages)

The box `amm/admin` is gated by the role `amm.admin` (its route's function `configure`); root
passes anything, so the host's key may send these too.

| message | swap records | event | the host |
|---|---|---|---|
| `enable {tokenId, beef?}` | row `enabled` under `amm/tokens`, the BEEF kept | `token-enabled {tokenId, beef, terms?, market?}` | see below |
| `disable {tokenId}` | row `disabled` | `token-disabled {tokenId}` | stops the instance (disabled; off its libp2p node); never removes it |
| `terms {tokenId, terms}` (0.12.0; `terms` the three fees, 0.14.0 with an optional `minLegSats` (sats), or `null`) | nothing (the token instance's `amm/terms` is the record) | `token-terms {tokenId, terms}` | sends root's `terms` to the token's instance (`amm/validator`); not replayed at start |
| `discovery {on}` | `{on, since}` under `amm/discovery` | `discovery-on` / `discovery-off` | starts / stops `discovery` |
| `defaults {terms?, market?}` (0.14.0: `terms` may carry `minLegSats`) | `amm/defaults` | none | the next `token-enabled` events carry them |
| `price {sats \| null}` (0.15.0; the price to enable a token, null: off) | `{sats}` under `amm/enable-price` (read: `enablePriceSats` on `/amm/defaults`; `enable-check` reads it) | none (0.15.3) | nothing |
| `claim` (box `amm/claim`, any sender; the first only) | `{claimant, since}` under `amm/claim` (read: `GET <swap>/amm/admin`) | `claimed {claimant}` | grants `amm.admin` on swap to the claimant (root's `grant`) |

When `token-enabled` names a token that has no instance yet, the host:

1. Creates the instance `<tokenId>` from the image `token`, disabled.
2. Records its names `[tm_color_<id>, ls_color_<id>, ls_amm_<id>]` for routing.
3. Feeds in the deploy as `{kind: "deploy", beef}` in `amm/deploy`. The door checks the BEEF.
4. If the deploy is admitted, publishes the instance.
5. Sends `terms` into `amm/validator` and `market` into `amm/amm-p2p`, each as root's
   message signed by the host's key.

If the door refuses the deploy:

- **A file store**: the instance is removed.
- **A set** (the host's SQLite database, RocksDB or LMDB): the instance is left disabled,
  because a set cannot be removed.

When `token-enabled` names a token whose instance exists:

- **A stopped instance**: it is started.
- **An instance with no token**: its deploy is fed in.

Every reaction is idempotent and logged.

**At start**, the host reconciles the host's instance table with swap's heads:

- `/amm/tokens`:
  - `enabled` means the instance is made running.
  - An enabled token with no instance is created. Its BEEF is read from swap's last
    `token-enabled` event in swap's log.
  - `disabled` means the instance is stopped.
- `/amm/discovery`: on means `discovery` is started; off means it is stopped.

Reads on swap (anyone):

- `/amm/tokens`: `[{tokenId, topic, sym, dec, status, since, iconUrl}]` (0.11.0: `iconUrl` =
  `/@discovery/1color/<tokenId>/icon`; the data-URL `icon` is gone)
- `/amm/defaults`: `{terms?, market?, enablePriceSats}` (0.15.0: `enablePriceSats` null when unset)
- `/amm/discovery`: `{on, since}`
- `/`: the pages

## The paid enable (0.15.3: a BEEF submission)

Any signed sender may enable a token for a fee, when the admin has set a price (`enablePriceSats` on
`/amm/defaults`). The request carries the payment in its body, beside the token's deploy, in ONE BEEF:

    POST <origin>/amm/enable?tokenId=<txid>_<vout>&paymentTxid=<hex>&paymentVout=<n>&derivationPrefix=<base64>&derivationSuffix=<base64>
    Content-Type: application/octet-stream
    body: one BEEF holding the token's deploy transaction and the payment transaction, each with its ancestry

The payment is a standard BRC-29 payment to the exchange: output `paymentVout` of `paymentTxid` pays at least the
price, P2PKH to the key derived with protocol `[2, "3241645161d8"]`, key id `"<prefix> <suffix>"`, counterparty
the exchange's identity key (`GET /.well-known/skein`). The client builds and signs it and does NOT send it: the
exchange's wallet takes it in, which is what sends it on.

The route's filters run before anything is recorded: `kernel.brc104` (signed), `kernel.beef` (the BEEF proven),
then the swap app's `enable-check`, which refuses in this order:

| refusal | status | code |
|---|---|---|
| no price set (the paid enable is off) | 403 | `ERR_PAID_ENABLE_OFF` |
| no `tokenId` | 400 | `ERR_BAD_REQUEST` |
| the token is enabled already | 409 | `ERR_TOKEN_ENABLED` |
| the token was disabled by the admin (only the admin enables it again) | 409 | `ERR_TOKEN_DISABLED` |
| the BEEF holds no deploy of that token | 400 | `ERR_BAD_DEPLOY` |
| no payment named, or the named output is not in the BEEF | 402 | `ERR_PAYMENT_REQUIRED` (body `{code, satoshisRequired}`) |
| the output holds less than the price | 402 | `ERR_PAYMENT_TOO_SMALL` (with `satoshisRequired`) |
| the payment transaction is in the exchange's wallet already | 409 | `ERR_PAYMENT_REPLAYED` |

The handler then checks the output pays the BRC-29 key derived for the signed sender (else 400
`ERR_INVALID_PAYMENT`, nothing enabled), hands the payment to swap's wallet (`internalize`, a wallet payment; the
request does not wait for it), enables the token as the admin's enable does (the default terms and market) and keeps
`{paidBy, paymentTxid, satoshisPaid}` on the row; it answers `{fn: "enable", result: <the row>}`. One fee, once;
only the admin disables. `@dcasegr/amm-client`'s `enableToken(tokenId, {deployBeef?})` does all of this.

## Requirements

- **Node 24 or later**, on any platform node runs on. Nothing else: no toolchain.
- **skein 0.3.3**, the npm dependency (`package.json`; 0.3.3: the door admits a txid-only BEEF entry for a transaction the instance holds — chain/state's `txs`, not `rejected` — so a swap names the pool's transaction by txid; 0.3.2: the application host's hook offered every method and a request's close signal — the swap route; 0.3.1: `P2PHost.call` with a signal, `Router.signMessage`; 0.2.9: paid routes, `kernel.pay` (not used since 0.15.3); 0.2.8: the host keeps its liveness beats in host.db and reloads them at start, so `/amm/pools` lists pools again right after a restart). Its host is built to JavaScript, and its
  kernel is one wasm file the host loads: one machine per active instance on a worker thread,
  every instance a set of the host's one SQLite database (`SKEIN_STORE_SQLITE`, the default
  the first run writes). A host.env naming `SKEIN_STORE_ROCKSDB` runs skein's native kernel process
  instead; that needs a skein checkout with its kernel built (the hosted shape).
- **One key** (skein#160): `SKEIN_KEY_FILE`. It owns every instance Open Exchange makes, swap
  included; the wallet that claims swap is its admin.
- **The images**: this repository's `image/`. Open Exchange sets `SKEIN_IMAGES_DIR` to it.

## The first run

`npx open-exchange` (no arguments: `run`) makes, in `$SKEIN_HOME` (default `~/.skein`), whatever
is missing, then serves:

- `host.env`, if absent, with four settings: the key file (`SKEIN_KEY_FILE`), the host's SQLite
  database (`SKEIN_STORE_SQLITE=$SKEIN_HOME/store.sqlite`, the wasm kernel), swap at the root
  (`SKEIN_ROOT_INSTANCE=swap`), and the network (`SKEIN_NETWORK=test`, or the one in the
  environment at the first run; testnet until mainnet has a hosted exchange).
- The key file, if absent (mode 0600).
- The host skein, as `skein-host init` does.
- `swap` from the image `swap`, owned by the host's key, unclaimed.
- `discovery` from the image `discovery`, with its `tm_color` and `ls_color` registered by
  root's messages.

Everything else is a per-network default in skein's host:

- the overlay's bootstrap peer (testnet: the hosted Open Exchange node);
- the Arcade (testnet: `https://testnet.arcade.1sat.app`). Its callback token is made on the
  first run and appended to `host.env`;
- the headers: the host follows the network's Teranode P2P mesh and syncs the chain from its
  data hub (skein#156). That sync is why the first start takes a few minutes.

A setting you add to `host.env` (another network, a port, a domain, another Arcade) wins over the
default. An existing `host.env` is left as it is. A later run makes nothing that exists.
(`open-exchange setup` is gone since 0.6.0: the first run does it.)

The admin is a claim. Open the pages, connect a wallet and go to Settings. While nobody has
claimed swap, Settings shows the card "Claim this exchange". The wallet that claims it (its
message `{fn: "claim"}` in box `amm/claim`) becomes the admin: the host grants it `amm.admin`,
and it enables tokens and sets terms. It is not root: the host's key stays swap's root. A second
claim is refused. `GET <swap>/amm/admin` answers `{claimant, since}`, or `{}`.

## Your first token (an admin's checklist)

The host needs no settings, but a fresh exchange takes no pool until its admin has done four
things, in this order. Each is one message from the admin's wallet; `@dcasegr/amm-client` has a
method for each, and the Settings page does the same from Yours.

1. **Claim** swap: `claimExchange()` (the message `{fn: "claim"}` in box `amm/claim`). The first
   wallet wins; `GET /amm/admin` names it.
2. **Default terms**: `setDefaultTerms({lpBps, validatorBps, commissionBps, minLegSats})`
   (`{fn: "defaults", args: {terms}}`). Until terms exist a token instance is a market only:
   `/@<token>/amm/terms` answers `validator: null`, `validatorTerms()` is `NO_VALIDATOR`, and
   `deployPosition` is refused. A token enabled before the defaults were set needs its own
   `setTokenTerms(tokenId, terms)` (`{fn: "terms"}`); the defaults apply to later enables.
   The client's input names are `lpBps` / `validatorBps` / `commissionBps`; the wire and the
   reads say `lpFeeBps` / `validatorFeeBps` / `commissionBps`.
3. **Discovery on**: `setDiscovery(true)` (`{fn: "discovery", args: {on: true}}`). A 1Color
   deploy is submitted to `tm_color` at this origin, which is the discovery instance; off, the
   deploy is refused and `/@discovery/1color/tokens` knows nothing.
4. **Enable** the token: the admin's free `enableToken(tokenId)` (`{fn: "enable"}`; the host finds
   the deploy's BEEF in the admin's wallet or on discovery), or anyone's paid `enableTokenPaid`
   once a price is set with `setEnablePrice(sats)`. `GET /amm/tokens` then lists it and
   `/@<token>/amm/pools` shows the host's validator beating.

After that a pool can be deployed and swapped. Right after start the `/amm/*` routes may answer
empty for a second or two while the instances come up; `/.well-known/skein` answering is not yet
"ready".

## Upgrade

```
npm install -g open-exchange@latest
```

(or run `npx open-exchange@latest`; in an install directory, `npm install open-exchange@<version>`), then restart
the host. That is the whole upgrade: the host does the rest at its start. It compares the packaged swap app's version
(`apps/swap/etc/app.json`) with the one installed in swap (its head `amm/app`) and, when they
differ, installs the packaged app into swap as the host's key (root), as `skein install` would:
the pages follow the package. A swap made by open-exchange 0.3.0–0.4.5 has no host root (its
root is whoever claimed it): `run` logs a warning and leaves its pages as they are.

Then (0.20.1) every enabled token instance and discovery: each app its image installs by tarball
(`image/token`, `image/discovery`) that differs from the installed app of that name is fetched once and,
when its version differs, installed in place the same way. (0.21.0: no reindex — the overlay has none since
0.24.0.) The log says, per instance:

```
<tokenId>: amm updated to 0.48.1 (from 0.46.2; N messages as root)
```

`run` takes every setting `skein-host run` takes from `host.env`. It serves everything
`skein-host` serves:

- bare-host routing by topic
- pages
- libp2p
- the chain feed
- Arcade

## Images (`image/<name>/etc/apps.json`, merged over skein's default image)

| image | installs |
|---|---|
| `swap` | skein-chain v0.12.1 (tarball), skein-signer v0.1.1 and skein-wallet v0.1.1 (tarballs), `../../apps/swap` (pages: skein-amm v0.52.0's web/ui); root's route `/` → the pages; created owned by the host's key. Approvals at birth from the manifests: swap `calls {signer: "*", wallet: ["bsv"]}`, the signer app's service `signer` |
| `token` | skein-chain v0.12.1, the signer app, the wallet app (as above), skein-amm v0.52.1 (tarball: the recognizers, `calls {signer: ["1/amm pool", "2/skein instance/self", "2/metanet handles envelope/anyone"], wallet: ["bsv", "tokens"]}`); root's `/submit`, `/lookup` |
| `discovery` | skein-chain v0.12.1, skein-1color v0.20.1 (tarballs); root's `/submit`, `/lookup` |

## Build and test

```
zig build test                      # the swap program's tests
zig build bin                       # apps/swap/bin/config.wasm (committed)
scripts/www.sh                      # apps/swap/www (committed): skein-amm 0.49.0's web/ui + the 1Color pages (skein-1color v0.14.0's www/) + api/
npm install --no-save <dcasegr-skein-0.7.0.tgz> <dcasegr-amm-engine-0.49.0.tgz>   # from their `npm pack` until published
npm run typecheck                   # host/ and scripts/ against node_modules/@dcasegr/skein
npm test                            # host/*.test.ts: unit tests against stubs (the swap relay's answer)
npm run build                       # dist/ (what the package runs; `npm pack` builds it)
[SKEIN_REPLAY_DIR=<skein checkout>] [SKEIN_EQUIV_STORE=rocksdb|file] [OX_ACCEPT_ZERO=off] npm run accept
```

The acceptance runs on the wasm host by default. `SKEIN_REPLAY_DIR` names a skein checkout with
its native kernel built: every store is then replayed by the native reference. From a package
install: `node node_modules/open-exchange/dist/scripts/accept/ox-accept.js`.

The acceptance (`scripts/accept/ox-accept.ts`) first runs `open-exchange` in a clean
`SKEIN_HOME` with nothing else set, on the real testnet (minutes: the first header sync; port
8100 must be free; `OX_ACCEPT_ZERO=off` skips it): `host.env` holds only the first run's four
settings and a made Arcade token, the log names the testnet Arcade and the overlay bootstrap
node, swap serves, a wallet claims it. Then it uses a scratch regtest host. It walks through
these steps:

1. the first run: swap and discovery owned by the host's key; `/amm/admin` → `{}`; a stranger's message
   in `amm/admin` runs nothing
2. the claim by the admin key: `/amm/admin` names it, the host grants `amm.admin`, root stays
   the host's; a second claim refused
3. run
4. enable: the instance is born, its deploy admitted, its names served, its beats seen, and
   bare-host `/lookup` is routed to it
5. (0.17.0) the host is the relay, on hosts of their own: a swap whose commission pays another key
   refused with nothing in the token's log; two, then three, swaps on one pool output relayed at once
   through the host's relay (the validator on its node) → one accepted, the others `pool_spent` with
   its continuation, the pools route at the new outpoint, its trade row; then the same race through
   ANOTHER host's relay (its own key, bootstrapped to the validator) → one accepted, the other
   `pool_spent`, the relaying host's overlay holding the accepted swap when it answers; the
   validator's host stopped → `unreachable` at once
7. disable, then enable again; one token's terms (40/6/3, then null, an unknown token refused)
8. discovery off, then on
9. a restart, with reconcile
10. swap's pages: a restart with a packaged swap app of another version installs it (as root)
11. a replay of every store
