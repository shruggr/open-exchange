// The instance part of `/stats` (amm-lookup 0.48.1 `stats`, D4: what the host does not recompute): the last fill, the
// 24 h volumes and buy / sell counts, the lifetime counters. The host adds tvl, pools, price and its changes
// (host/pools.ts `mergeStats`), as before.
// 0.25.0 (David 2026-11-11: stats from the event log, no re-sort): the last trade is the LAST swap event (whatever its
// `at`); the 24 h figures (now − 24 h < at ≤ now) are the minute tallies of that day (candles.ts `Tally`), the two
// edge minutes tallied from their trades inside the window; the lifetime counters are the fold's, kept as each swap
// arrives and taken back on a revert. After a history load every loaded trade carrying the load's time counts in the
// first day: accepted (it times out).
import type { TokenFold } from "./fold.ts";
import { priceOf, type Hop } from "./hop.ts";
import type { Rec } from "../events.ts";

export const DAY_MS = 86_400_000;

export function instanceStats(f: TokenFold, now: number): Rec {
  let last: Hop | undefined;
  for (let i = f.hops.length - 1; i >= 0; i--) if (f.hops[i]!.kind === "swap") { last = f.hops[i]; break; }
  let volume24hSats = 0n, volume24hTokens = 0n, buys24h = 0, sells24h = 0;
  const start = Math.max(0, now - DAY_MS);
  // The window is start < at ≤ now: the tallies' half-open [start + 1, now + 1).
  for (const m of f.tally.window(start + 1, now + 1)) {
    volume24hSats += m.volumeSats; volume24hTokens += m.volumeTokens; buys24h += m.buys; sells24h += m.sells;
  }
  const lp = last ? priceOf(last) : undefined;
  return {
    tokenId: f.tokenId,
    lastTradePrice: lp ?? null,
    volume24hSats, volume24hTokens, buys24h, sells24h,
    lastTradeAt: last?.at ?? null,
    volumeSats: f.volumeSats, volumeTokens: f.volumeTokens, trades: f.trades,
  };
}
