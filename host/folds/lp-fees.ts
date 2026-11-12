// `GET <origin>/amm/lp/fees?pool=<poolId>,<poolId>&from=<ms>&to=<ms>` (David 2026-11-12, Dan's relay #34): the LP fees
// of the named pools' swaps, summed by the host from the analytics store (any token the host has rows for). A swap is
// placed by its `at`: from ≤ at < to, each bound optional (absent: all time; echoed null). A swap's LP fee is its `feeLp`,
// in sats when it is a buy, in the pool's token when it is a sell. Amounts as exact decimal strings.
//
//   {from, to, sats, tokens: [{tokenId, amount}], swaps, pools, byPool: [{poolId, tokenId, sats, tokens, swaps}]}
//
// `pools` counts the pools with at least one such swap; `byPool` lists those, in the query's order; `tokens` one entry
// per token of those pools, in the order its first pool appears.
import type { Analytics } from "../analytics.ts";
import type { Hop } from "./hop.ts";
import { lpFees } from "./counters.ts";
import { BadQuery } from "./trades.ts";
import type { Rec } from "../events.ts";

const POOL_ID = /^[0-9a-f]{64}_\d+$/;

export function lpFeesRead(a: Analytics, q: URLSearchParams): Rec {
  const ids = [...new Set((q.get("pool") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""))];
  if (ids.length === 0) throw new BadQuery("want ?pool=<txid>_<vout>[,…]");
  for (const id of ids) if (!POOL_ID.test(id)) throw new BadQuery(`pool: <txid>_<vout> (${id})`);
  const int = (k: string) => { const v = q.get(k); if (v === null) return undefined; if (!/^\d+$/.test(v)) throw new BadQuery(`${k}: an integer`); return Number(v); };
  const from = int("from"), to = int("to");
  const byId = new Map<string, { tokenId: string; hops: Hop[] }>();
  for (const { tokenId, hop } of a.poolSwaps(ids, from, to)) {
    let p = byId.get(hop.poolId);
    if (!p) byId.set(hop.poolId, p = { tokenId, hops: [] });
    p.hops.push(hop);
  }
  let sats = 0n, swaps = 0;
  const tokens = new Map<string, bigint>();
  const byPool: Rec[] = [];
  for (const poolId of ids) {
    const p = byId.get(poolId);
    if (!p) continue;
    const f = lpFees(p.hops);
    sats += f.sats; swaps += f.swaps;
    tokens.set(p.tokenId, (tokens.get(p.tokenId) ?? 0n) + f.tokens);
    byPool.push({ poolId, tokenId: p.tokenId, sats: f.sats.toString(), tokens: f.tokens.toString(), swaps: f.swaps });
  }
  return {
    from: from ?? null, to: to ?? null,
    sats: sats.toString(),
    tokens: [...tokens].map(([tokenId, amount]) => ({ tokenId, amount: amount.toString() })),
    swaps, pools: byPool.length, byPool,
  };
}
