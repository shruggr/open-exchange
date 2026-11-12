# Open Exchange read API

The route table below is generated from open-exchange's `api/openapi.json` (OpenAPI 3.1) at
build by `scripts/skill-sync.js`. The live spec is `<origin>/api/openapi.json`; the rendered
reference page is `<origin>/api/`. Default server: `https://testnet.openex.dev`.

Search the JSON instead of loading it whole:

```bash
spec() { curl -s https://testnet.openex.dev/api/openapi.json; }
spec | jq '.paths["/@{token}/amm/pools"].get'                         # one operation
spec | jq '.components.schemas | keys'                                 # schema names
spec | jq '.paths | to_entries[] | select(.value.get.tags[0]=="history") | .key'
```

## Conventions (from the spec)

- Plain HTTP GETs, JSON unless a route says bytes. List parameters are comma-separated and
  answered one record per key, in query order.
- `{token}` is a token id `<txid>_<vout>` (`_0` for a 1Color token). A token's routes live under
  its instance: `/@<token>/amm/...`. A pool id is the pool's deploy outpoint `<txid>_<vout>`; a
  pool's `outpoint` is its CURRENT output and changes on every swap.
- Amounts and prices are integers in base units. A price is a pair `{sats, tokens}`; sats per
  whole token = `sats * 10^dec / tokens` (`pairPrice` in the client). `change1h` / `change24h`
  are basis points.
- Cache classes (`x-cache` on each operation): `state` = `public, max-age=5`; `imm` = immutable,
  only for bytes of a proven transaction; `stream` = `text/event-stream`; some host reads send no
  `Cache-Control`.
- Writes are NOT on this API: overlay `POST /submit` (BRC-22, header `x-topics`) and
  `POST /lookup` (BRC-24), signed admin messages (`/sendMessage`, `/call`, via the client), the
  swap relay and the paid enable below.

## Routes

Exercised live through the client, the app or the headless harness (hand-maintained; the rest
are from the spec and README): `/amm/events`, `/@{token}/amm/pools`, `/terms`,
`/amm/stats`, `/trades`, `/candles`, `/@{token}/amm/stats`, `/holders`, `/@{token}/amm/positions`,
`/amm/spends`, `/tx`, the swap relay, `/amm/tokens`, `/@discovery/1color/tokens`, `/icon`,
`/deploy`, `/.well-known/skein`, `/amm/admin`, `/amm/defaults`, `/amm/discovery`, the paid enable,
`/api/openapi.json`, `/api/`.

<!-- generated: routes -->
### 35 routes, 8 tags (OpenAPI document version 0.28.2)

| tag | method | path | query (`*` required) | cache | summary |
|---|---|---|---|---|---|
| pools | GET | `/amm/pools` |  | state | Every enabled token's live pools |
| pools | GET | `/amm/events` |  | stream | Every enabled token's pool events |
| pools | GET | `/@{token}/amm/pools` |  | state | A token's live pools and its market |
| pools | GET | `/@{token}/amm/events` |  | stream | A token's pool events |
| pools | GET | `/@{token}/amm/terms` |  | state | Validator and market terms |
| history | GET | `/amm/stats` | ids | state | Every enabled token's stats |
| history | GET | `/amm/positions` | pool* | state | Pool positions across tokens |
| history | GET | `/@{token}/amm/pools/at` | t* | state | The pools at a time |
| history | GET | `/@{token}/amm/pools/history` | from, to, pool, limit, after, outpoint | state | The pool history |
| history | GET | `/@{token}/amm/trades` | from, to, limit, before, pool, txid | state | A token's trades |
| history | GET | `/@{token}/amm/candles` | tf*, from*, to*, series | state | A token's candles |
| history | GET | `/@{token}/amm/stats` |  | state | A token's stats |
| history | GET | `/@{token}/amm/color/{tokenId}/holders` | limit, skip | state | A token's holders |
| fees | GET | `/amm/lp/fees` | pool*, from, to | state | LP fees of pools over a period |
| fees | GET | `/@{token}/amm/positions` | pool* | state | Pool positions by pool id |
| chain | GET | `/amm/spends` | outpoint* | state | Outpoint spends across tokens |
| chain | GET | `/@{token}/amm/spends` | outpoint* | state | Outpoint spends |
| chain | GET | `/@{token}/amm/tx` | id* | imm (proven) / state | A transaction's BEEF |
| tokens | GET | `/@{token}/amm/token` |  | none (no Cache-Control header) | The token instance's token |
| tokens | GET | `/amm/tokens` |  | none (no Cache-Control header) | The exchange's token list |
| tokens | GET | `/@discovery/1color/tokens` | ids, q, after, limit, skip | state | Discovery's token list |
| tokens | GET | `/@discovery/1color/{token}` |  | state | A listed token |
| tokens | GET | `/@discovery/1color/{token}/icon` |  | imm (proven) / state | A token's icon |
| tokens | GET | `/@discovery/1color/{token}/deploy` |  | imm (proven) / state | A token's deploy BEEF |
| host, swaps | POST | `/@{token}/amm/swap` |  |  | Relay a swap leg to its validator (the host is the relay) |
| host | GET | `/.well-known/skein` |  | none (no Cache-Control header) | The instance card |
| host | GET | `/skeins` | key* | none (no Cache-Control header) | Instances a key holds root on |
| host | GET | `/amm/admin` |  | none (no Cache-Control header) | The exchange's claimant |
| host | GET | `/amm/defaults` |  | none (no Cache-Control header) | Defaults for new token instances |
| host | GET | `/amm/discovery` |  | none (no Cache-Control header) | Discovery on or off |
| host | POST | `/amm/enable` | tokenId*, paymentTxid*, paymentVout*, derivationPrefix*, derivationSuffix* | none | Enable a token for a fee (a BEEF submission) |
| docs | GET | `/api/openapi.json` |  | as the swap pages are served | This document |
| docs | GET | `/api/` |  | as the swap pages are served | The reference page |
| docs | GET | `/api/skill.md` |  | as the swap pages are served | The agent skill |
| docs | GET | `/api/llms.txt` |  | as the swap pages are served | llms.txt |
<!-- /generated -->

A pool's transaction is `/@{token}/amm/tx?id=<txid of its current outpoint>` (`/pools/beef` is
gone since open-exchange 0.19.0). Candles have one series, `fill` (`series=market` answers 400
since 0.25.0). The trades cursor `next` / `before` is an event place `<s>.<i>.<thread>`; rows
come in event order, and `at` is the block's time when the transaction was mined on arrival.

## Answer shapes worth knowing

```jsonc
// GET /@<token>/amm/pools  (illustrative values)
{ "market": { "identityKey": "<pubkey>", "minCommissionBps": 0 },
  "validators": [{ "identity": "<pubkey>", "peerId": "16Uiu2...", "minLegSats": 100000 }],
  "pools": [{ "poolId": "<deploy txid>_0", "outpoint": "<current txid>_0", "lpPubKey": "...",
              "bsvReserve": 104207588, "tokenReserve": 479811567, "liquidityFeeBps": 35,
              "validationFeeBps": 10, "commissionBps": 5, "validatorIdentityKey": "...",
              "validatorPeerId": "...", "swaps": 54 }] }

// GET /amm/spends?outpoint=a.1,b.2
[{ "outpoint": "a.1", "tokenId": "<id>", "spentBy": "<txid>" }, { "outpoint": "b.2" }]

// GET /amm/lp/fees?pool=<poolId>,<poolId>&from=<ms>&to=<ms>  (from ≤ at < to, both optional;
// a buy's feeLp in sats, a sell's in the pool's token; amounts are decimal strings;
// the client's lpFees(poolIds, {from?, to?}) reads it, amounts as bigints, amm-client 0.55.1)
{ "from": 1793000000000, "to": 1793086400000, "sats": "42",
  "tokens": [{ "tokenId": "<id>", "amount": "105" }], "swaps": 3, "pools": 1,
  "byPool": [{ "poolId": "<poolId>", "tokenId": "<id>", "sats": "42", "tokens": "105", "swaps": 3 }] }
```

## The swap relay (`POST /@<token>/amm/swap`)

Use the client (`executeSwap`); do not hand-build legs. Facts from the spec and README (docs):
plain (no BRC-104 session); the host checks ONE rule, that the leg's commission pays this
exchange's key (`commission_missing` otherwise); everything else is the validator's. Answers:
`{ok: true, tx, txid, beef?}` / `{ok: false, reason, detail?, pool?, beef?}` /
`{ok: false, reason: "unreachable", detail}`. The client's request close is the only timer
(`LEG_PATIENCE_MS` = 15 s). From open-exchange 0.18.0: transactions the token's topic
already admitted go by txid alone in the BEEF; a txid-only entry the validator does not hold is
`bad_transaction` (`UnknownTxidOnly: …`), nothing signed.

What the validator answers (skein-amm 0.51.0, one step per request, nothing waits: no `pending`):
the first leg on a pool is signed and handed to its overlay; each later one is `pool_spent` at
once, with the pool's newest state (`pool`) and its transaction (`beef`). After signing:
`submit_refused` (the overlay refused it, e.g. `InputSpent: …`), `topic_refused`, `rejected` (the
network's reason). From open-exchange 0.23.0 an accepted leg is answered only when this host's
broadcast of it is taken by the broadcaster (Arcade); refused there, the answer is
`{ok: false, reason: "rejected", detail: <the broadcaster's reason>}`. `missing_signature` and
`bad_signature` are gone (skein-amm 0.50.1).

## Overlay writes (verified)

```http
POST <origin>/lookup
content-type: application/json
{"service":"ls_color_<assetId>","query":{"type":"color-spendability"|"color-admission",
 "version":1,"assetId":"<assetId>","topic":"tm_color_<assetId>","outpoints":["<txid>.<vout>"]}}

POST <origin>/submit
content-type: application/octet-stream
x-topics: ["tm_color_<assetId>"]
<AtomicBEEF bytes>          -> STEAK JSON
```

Topic and lookup names are derived, never typed: `topicOf(id)` = `tm_color_<id>`,
`lookupOf(id)` = `ls_color_<id>`, `ammLookupOf(id)` = `ls_amm_<id>`.
