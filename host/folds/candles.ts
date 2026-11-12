// The candle tallies and `/candles?tf&from&to` (0.25.0, plans/research/plan-pass-host-candles.md §2-§3; David 2026-11-11:
// the candles are the HOST's, kept in memory from the trade events as they arrive, no re-sort on read).
//
// Per token: one tally per minute that has trades (the minute from the trade's own `at`), updated as each swap event
// arrives: o / h / l / c (the fill prices, `priceOf`), volumeSats, volumeTokens, n, buys, sells, and the minute's trades
// in ARRIVAL order (event order; open = the first to arrive, close = the last). A rollback (the revert row) takes its
// trade out of its minute and works the minute out again from the trades left, or removes the minute when none are
// left; a re-admitted trade arrives as a new event. The minutes with trades are kept in time order (`keys`), so a read
// never sorts. Nothing is written anywhere: rebuilt from the events at every start (the replay).
//
// `/candles` (the FILL series): the swaps with from ≤ at < to, one candle per non-empty bucket of tf ms (aligned to
// multiples of tf since the epoch), oldest first: {t, o, h, l, c, volumeSats, volumeTokens, n}; a bucket is its minutes
// added up in time order (o the first minute's, c the last's); the two minutes the window's edges cut are tallied from
// their trades inside the window. More than 5000 buckets: refused.
import type { TokenFold } from "./fold.ts";
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

/** The first index of `keys` (ascending) whose key is ≥ x. */
export function lowerBound(keys: number[], x: number): number {
  let lo = 0, hi = keys.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (keys[mid]! < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** A token's minute tallies. */
export class Tally {
  /** The minutes with trades, by minute start. */
  readonly minutes = new Map<number, Minute>();
  /** The minute starts with trades, ascending. */
  readonly keys: number[] = [];

  /** A swap event arrived: into its minute (a swap with no price is not tallied). */
  add(h: Hop): void {
    const p = priceOf(h);
    if (!p) return;
    const t = minuteOf(h.at);
    const m = this.minutes.get(t);
    if (!m) {
      this.minutes.set(t, tallyOf([h], t)!);
      const k = this.keys;
      if (k.length === 0 || k[k.length - 1]! < t) k.push(t); else k.splice(lowerBound(k, t), 0, t);
      return;
    }
    if (priceLt(m.h, p)) m.h = p;
    if (priceLt(p, m.l)) m.l = p;
    m.c = p;
    m.volumeSats += p.sats; m.volumeTokens += p.tokens; m.n++;
    if (h.side === "buy") m.buys++; else m.sells++;
    m.trades.push(h);
  }

  /** A swap rolled back: out of its minute, the minute worked out again from the trades left, or removed when none are. */
  remove(h: Hop): void {
    const t = minuteOf(h.at);
    const m = this.minutes.get(t);
    const i = m ? m.trades.indexOf(h) : -1;
    if (!m || i < 0) return;
    const left = m.trades.filter((x) => x !== h);
    const again = tallyOf(left, t);
    if (again) { this.minutes.set(t, again); return; }
    this.minutes.delete(t);
    const at = lowerBound(this.keys, t);
    if (this.keys[at] === t) this.keys.splice(at, 1);
  }

  /**
   * The minutes holding trades with lo ≤ at < hi, in time order: a minute wholly inside as it is, a minute the window
   * cuts tallied from its trades inside the window (none: left out).
   */
  *window(lo: number, hi: number): Generator<Minute> {
    for (let i = lowerBound(this.keys, minuteOf(lo)); i < this.keys.length && this.keys[i]! < hi; i++) {
      const t = this.keys[i]!, m = this.minutes.get(t)!;
      if (t >= lo && t + MINUTE_MS <= hi) { yield m; continue; }
      const cut = tallyOf(m.trades.filter((h) => h.at >= lo && h.at < hi), t);
      if (cut) yield cut;
    }
  }
}

export function candles(f: TokenFold, q: URLSearchParams): Candle[] {
  const bad = "want ?tf=1m|5m|15m|1h|4h|1d&from=<ms>&to=<ms>";
  const tf = TF[q.get("tf") ?? ""];
  const from = q.get("from"), to = q.get("to");
  if (!tf || !from || !to || !/^\d+$/.test(from) || !/^\d+$/.test(to) || Number(to) < Number(from)) throw new BadQuery(bad);
  const lo = Number(from), hi = Number(to);
  const start = lo - (lo % tf);
  if (Math.ceil((hi - start) / tf) > MAX_BUCKETS) throw new BadQuery(`the window spans more than ${MAX_BUCKETS} buckets`);
  const out: Candle[] = [];
  for (const m of f.tally.window(lo, hi)) {
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
