// The instance part of `/stats` (amm-lookup 0.48.1 `stats`, D4: what the host does not recompute): the last fill at or
// before now, the 24 h volumes and buy / sell counts, the lifetime counters. The host adds tvl, pools, price and
// its changes (host/pools.ts `mergeStats`), as before.
import type { TokenFold } from "./fold.ts";
import { priceOf } from "./hop.ts";
import { tokenCounters } from "./counters.ts";
import type { Rec } from "../events.ts";

export const DAY_MS = 86_400_000;

export function instanceStats(f: TokenFold, now: number): Rec {
  const swaps = f.swaps();
  let last: (typeof swaps)[number] | undefined;
  for (const h of swaps) if (h.at <= now) last = h;
  let volume24hSats = 0n, volume24hTokens = 0n, buys24h = 0, sells24h = 0;
  const start = Math.max(0, now - DAY_MS);
  for (const h of swaps) {
    if (h.at <= start || h.at > now) continue;
    const p = priceOf(h);
    if (!p) continue;
    volume24hSats += p.sats; volume24hTokens += p.tokens;
    if (h.side === "buy") buys24h++; else sells24h++;
  }
  const t = tokenCounters(f);
  const lp = last ? priceOf(last) : undefined;
  return {
    tokenId: f.tokenId,
    lastTradePrice: lp ?? null,
    volume24hSats, volume24hTokens, buys24h, sells24h,
    lastTradeAt: last?.at ?? null,
    volumeSats: t.volumeSats, volumeTokens: t.volumeTokens, trades: t.trades,
  };
}
