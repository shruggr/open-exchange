// The candle tallies and `/candles?tf&from&to` (0.25.0, plans/research/plan-pass-host-candles.md §2-§3; David 2026-11-11:
// the candles are the HOST's; 2026-11-12: read from the analytics store, nothing in memory).
//
// Per token: one tally per minute that has trades (the minute from the trade's own `at`), worked out on read from the
// standing swaps: o / h / l / c (the fill prices, `priceOf`), volumeSats, volumeTokens, n, buys, sells, the minute's
// trades in EVENT order (open = the first event, close = the last). A rolled-back trade is not in the store (the revert
// removed its row); a re-admitted trade arrives as a new event.
//
// `/candles` (the FILL series): the swaps with from ≤ at < to, one candle per non-empty bucket of tf ms (aligned to
// multiples of tf since the epoch), oldest first: {t, o, h, l, c, volumeSats, volumeTokens, n}; a bucket is its minutes
// added up in time order (o the first minute's, c the last's); the two minutes the window's edges cut are tallied from
// their trades inside the window. More than 5000 buckets: refused.
import type { Analytics } from "../analytics.ts";
import { priceLt, priceOf, type Hop, type Price } from "./hop.ts";
import { BadQuery } from "./trades.ts";

export const TF: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
export const MAX_BUCKETS = 5000;
export const MINUTE_MS = 60_000;

export interface Candle { t: number; o: Price; h: Price; l: Price; c: Price; volumeSats: bigint; volumeTokens: bigint; n: number }

/** One minute's tally: its candle, its buy and sell counts, its trades in arrival order (the fold's own hops). */
export interface Minute extends Candle { buys: number; sells: number; trades: Hop[] }

/** The minute a time falls in. */
export const minuteOf = (at: number): number => at - (at % MINUTE_MS);

/** The tally of a list of priced swaps in arrival order (o the first, c the last), under minute `t`; undefined when empty. */
export function tallyOf(trades: Hop[], t: number): Minute | undefined {
  let m: Minute | undefined;
  for (const h of trades) {
    const p = priceOf(h);
    if (!p) continue;
    if (!m) m = { t, o: p, h: p, l: p, c: p, volumeSats: 0n, volumeTokens: 0n, n: 0, buys: 0, sells: 0, trades: [] };
    if (priceLt(m.h, p)) m.h = p;
    if (priceLt(p, m.l)) m.l = p;
    m.c = p;
    m.volumeSats += p.sats; m.volumeTokens += p.tokens; m.n++;
    if (h.side === "buy") m.buys++; else m.sells++;
    m.trades.push(h);
  }
  return m;
}

/**
 * The minutes holding swaps with lo ≤ at < hi, in time order, each tallied from its swaps inside the window in event
 * order (the store's query: by minute of `at`, then event place).
 */
export function* window(a: Analytics, tokenId: string, lo: number, hi: number): Generator<Minute> {
  let t: number | undefined, group: Hop[] = [];
  for (const h of a.swapsByMinute(tokenId, lo, hi)) {
    const m = minuteOf(h.at);
    if (t !== undefined && m !== t) { const x = tallyOf(group, t); if (x) yield x; group = []; }
    t = m; group.push(h);
  }
  if (t !== undefined) { const x = tallyOf(group, t); if (x) yield x; }
}

export function candles(a: Analytics, tokenId: string, q: URLSearchParams): Candle[] {
  const bad = "want ?tf=1m|5m|15m|1h|4h|1d&from=<ms>&to=<ms>";
  const tf = TF[q.get("tf") ?? ""];
  const from = q.get("from"), to = q.get("to");
  if (!tf || !from || !to || !/^\d+$/.test(from) || !/^\d+$/.test(to) || Number(to) < Number(from)) throw new BadQuery(bad);
  const lo = Number(from), hi = Number(to);
  const start = lo - (lo % tf);
  if (Math.ceil((hi - start) / tf) > MAX_BUCKETS) throw new BadQuery(`the window spans more than ${MAX_BUCKETS} buckets`);
  const out: Candle[] = [];
  for (const m of window(a, tokenId, lo, hi)) {
    const t = m.t - (m.t % tf);
    const c = out[out.length - 1];
    if (c && c.t === t) {
      if (priceLt(c.h, m.h)) c.h = m.h;
      if (priceLt(m.l, c.l)) c.l = m.l;
      c.c = m.c; c.volumeSats += m.volumeSats; c.volumeTokens += m.volumeTokens; c.n += m.n;
    } else out.push({ t, o: m.o, h: m.h, l: m.l, c: m.c, volumeSats: m.volumeSats, volumeTokens: m.volumeTokens, n: m.n });
  }
  return out;
}
