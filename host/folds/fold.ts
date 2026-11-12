// A token instance's fold (0.21.0; G2, David: the newest-first and aggregate reads are the HOST's, folded from the
// event stream, with today's paths and JSON). In memory only, rebuilt at every start by replaying the instance's
// `amm/hop` events from place zero (events-as-index-2026-11-07 "rebuilt by replay from place zero"), then live.
//
// Kept: every hop in log order (a reverted hop's transaction dropped from it), and each pool's latest hop (its
// current state). 0.25.0 (David 2026-11-11: trades in EVENT order, never re-sorted; the candles the host's own): the
// hops stay in the order they arrive, nothing re-sorts them; beside them the minute candle tallies (candles.ts `Tally`)
// and the lifetime counters, both updated as each swap arrives and taken back when a revert row unwinds it. Every read
// is a function of these (one module per route: trades.ts, candles.ts, stats.ts, pools-at.ts, pool-history.ts,
// pools.ts).
import { hopOf, priceOf, type Hop } from "./hop.ts";
import { Tally } from "./candles.ts";
import type { Rec } from "../events.ts";

export type Status = "live" | "rescinded" | "closed";

export class TokenFold {
  readonly tokenId: string;
  /** Every hop not reverted, in log order. */
  hops: Hop[] = [];
  /** Each pool's latest hop (its state now), by pool id. */
  readonly current = new Map<string, Hop>();
  /** The minute candle tallies (0.25.0). */
  readonly tally = new Tally();
  /** The lifetime counters (0.25.0): every swap's price amounts (a priced swap's) and the swap count. */
  volumeSats = 0n;
  volumeTokens = 0n;
  trades = 0;
  /** Called with each hop as it is folded (the pool feeds). */
  onHop?: (h: Hop) => void;

  constructor(tokenId: string) { this.tokenId = tokenId; }

  /**
   * Fold one `amm/hop` row at its index place; returns the hop, or undefined when the record is not one. THE STANDING
   * RULE: every row whose `txid` a later `revert` row names is dropped.
   */
  take(rec: Rec, place = ""): Hop | undefined {
    const h = hopOf(rec, place);
    if (!h) return undefined;
    if (h.kind === "revert") {
      // The reverted transaction's hops leave the history; the pool stands as the revert row says (no outpoint: gone).
      const kept: Hop[] = [];
      for (const x of this.hops) { if (x.txid !== h.txid) kept.push(x); else if (x.kind === "swap") this.count(x, -1); }
      this.hops = kept;
      if (h.outpoint) this.current.set(h.poolId, h); else this.current.delete(h.poolId);
    } else {
      this.hops.push(h);
      this.current.set(h.poolId, h);
      if (h.kind === "swap") this.count(h, 1);
    }
    this.onHop?.(h);
    return h;
  }

  /** A swap into (+1) or out of (−1) the tallies and the lifetime counters. */
  private count(h: Hop, by: 1 | -1): void {
    this.trades += by;
    const p = priceOf(h);
    if (p) { this.volumeSats += BigInt(by) * p.sats; this.volumeTokens += BigInt(by) * p.tokens; }
    if (by === 1) this.tally.add(h); else this.tally.remove(h);
  }

  /** A pool's status now. */
  status(poolId: string): Status {
    const h = this.current.get(poolId);
    if (!h || !h.outpoint || h.kind === "close") return "closed";
    return h.kind === "rescind" ? "rescinded" : "live";
  }

  /** The listed pools now (live, not rescinded): their latest hops, in outpoint order. */
  live(): Hop[] {
    return [...this.current.values()].filter((h) => this.status(h.poolId) === "live").sort((x, y) => (x.outpoint! < y.outpoint! ? -1 : x.outpoint! > y.outpoint! ? 1 : 0));
  }
}
