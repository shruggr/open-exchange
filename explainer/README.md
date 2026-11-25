# Open Exchange explainer

A standalone landing page explaining how the Open Exchange works: instances,
validators, relay markets, pools and swaps. Audience is executive/investor
level — P2P-aware, but no skein internals and no sales pitch.

It is deliberately separate from the exchange's generated `apps/swap/www`
(which `scripts/www.sh` rebuilds). This page has no build step and no runtime
dependencies.

## Run it

```
python3 -m http.server 8099
```

Open <http://127.0.0.1:8099/>.

## Files

- `index.html` — the page and the SVG role map.
- `style.css` — skein brand palette and self-hosted fonts.
- `app.js` — clickable roles and the seven-step swap walkthrough.
- `fonts/` — Outfit, Instrument Sans and IBM Plex Mono, with their OFL
  licences.

## What it says

- The exchange is non-custodial: the wallet holds the funds; a swap is an
  ordinary BSV transaction.
- A pool is an on-chain AMM output, not a server database row.
- Each enabled token gets its own instance, with its own validator, relay and
  public lookup; discovery is a separate optional instance.
- Validators compete on runtime-set terms; the relay's minimum commission is
  a listing preference, not an enforcement rule.
- Honest limits: BSV is the settlement layer and final arbiter; a hosted
  exchange is one machine with one operator key; the first wallet claim is
  admin, not root.

Live on BSV testnet while the exchange and its host are under active
development.
