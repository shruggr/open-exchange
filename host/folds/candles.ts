// `/candles?tf&from&to` (amm-lookup 0.48.1 `candles`, the FILL series): the swaps with from ≤ at < to, one candle per
// non-empty bucket of tf ms (aligned to multiples of tf since the epoch), oldest first: {t, o, h, l, c, volumeSats,
// volumeTokens, n}, the prices `{sats, tokens}` of the fills. More than 5000 buckets: refused.
import type { TokenFold } from "./fold.ts";
import { priceLt, priceOf, type Price } from "./hop.ts";
import { BadQuery } from "./trades.ts";

export const TF: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
export const MAX_BUCKETS = 5000;

export interface Candle { t: number; o: Price; h: Price; l: Price; c: Price; volumeSats: bigint; volumeTokens: bigint; n: number }

export function candles(f: TokenFold, q: URLSearchParams): Candle[] {
  const bad = "want ?tf=1m|5m|15m|1h|4h|1d&from=<ms>&to=<ms>";
  const tf = TF[q.get("tf") ?? ""];
  const from = q.get("from"), to = q.get("to");
  if (!tf || !from || !to || !/^\d+$/.test(from) || !/^\d+$/.test(to) || Number(to) < Number(from)) throw new BadQuery(bad);
  const lo = Number(from), hi = Number(to);
  const start = lo - (lo % tf);
  if (Math.ceil((hi - start) / tf) > MAX_BUCKETS) throw new BadQuery(`the window spans more than ${MAX_BUCKETS} buckets`);
  const out: Candle[] = [];
  for (const h of f.swaps()) {
    if (h.at < lo || h.at >= hi) continue;
    const p = priceOf(h);
    if (!p) continue;
    const t = h.at - (h.at % tf);
    const c = out[out.length - 1];
    if (c && c.t === t) {
      if (priceLt(c.h, p)) c.h = p;
      if (priceLt(p, c.l)) c.l = p;
      c.c = p; c.volumeSats += p.sats; c.volumeTokens += p.tokens; c.n++;
    } else out.push({ t, o: p, h: p, l: p, c: p, volumeSats: p.sats, volumeTokens: p.tokens, n: 1 });
  }
  return out;
}
