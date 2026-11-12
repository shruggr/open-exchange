// The instance part of `/stats` (amm-lookup 0.48.1 `stats`, D4: what the host does not recompute): the last fill, the
// 24 h volumes and buy / sell counts, the lifetime counters. The host adds tvl, pools, price and its changes
// (host/pools.ts `mergeStats`), as before.
// 0.25.0 (David 2026-11-11: stats from the event log, no re-sort): the last trade is the LAST swap event (whatever its
// `at`); the 24 h figures (now − 24 h < at ≤ now) are the minute tallies of that day (candles.ts `window`), the two
// edge minutes tallied from their trades inside the window; the lifetime counters summed from the standing swaps
// (2026-11-12: all read from the analytics store, nothing kept in memory). After a history load every loaded trade carrying the load's time counts in the
// first day: accepted (it times out).
import type { Analytics } from "../analytics.ts";
import { priceOf } from "./hop.ts";
import { window } from "./candles.ts";
import type { Rec } from "../events.ts";

export const DAY_MS = 86_400_000;

export function instanceStats(a: Analytics, tokenId: string, now: number): Rec {
  const last = a.lastSwap(tokenId);
  let volume24hSats = 0n, volume24hTokens = 0n, buys24h = 0, sells24h = 0;
  const start = Math.max(0, now - DAY_MS);
  // The window is start < at ≤ now: the tallies' half-open [start + 1, now + 1).
  for (const m of window(a, tokenId, start + 1, now + 1)) {
    volume24hSats += m.volumeSats; volume24hTokens += m.volumeTokens; buys24h += m.buys; sells24h += m.sells;
  }
  let volumeSats = 0n, volumeTokens = 0n, trades = 0;
  for (const h of a.swaps(tokenId)) {
    trades++;
    const p = priceOf(h);
    if (p) { volumeSats += p.sats; volumeTokens += p.tokens; }
  }
  const lp = last ? priceOf(last) : undefined;
  return {
    tokenId,
    lastTradePrice: lp ?? null,
    volume24hSats, volume24hTokens, buys24h, sells24h,
    lastTradeAt: last?.at ?? null,
    volumeSats, volumeTokens, trades,
  };
}
