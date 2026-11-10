// A token instance's fold (0.21.0; G2, David: the newest-first and aggregate reads are the HOST's, folded from the
// event stream, with today's paths and JSON). In memory only, rebuilt at every start by replaying the instance's
// `amm/hop` events from place zero (events-as-index-2026-11-07 "rebuilt by replay from place zero"), then live.
//
// Kept: every hop in log order (a reverted hop's transaction dropped from it), and each pool's latest hop (its
// current state). Every read is a function of these (one module per route: trades.ts, candles.ts, stats.ts,
// pools-at.ts, pool-history.ts, positions.ts, pools.ts).
import { hopOf, type Hop } from "./hop.ts";
import type { Rec } from "../events.ts";

export type Status = "live" | "rescinded" | "closed";

export class TokenFold {
  readonly tokenId: string;
  /** Every hop not reverted, in log order. */
  hops: Hop[] = [];
  /** Each pool's latest hop (its state now), by pool id. */
  readonly current = new Map<string, Hop>();
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
      this.hops = this.hops.filter((x) => x.txid !== h.txid);
      if (h.outpoint) this.current.set(h.poolId, h); else this.current.delete(h.poolId);
    } else {
      this.hops.push(h);
      this.current.set(h.poolId, h);
    }
    this.onHop?.(h);
    return h;
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

  /** The swaps, oldest first by (at, txid) — the instance's `trades` order. */
  swaps(): Hop[] {
    return this.hops.filter((h) => h.kind === "swap").sort((x, y) => x.at - y.at || (x.txid < y.txid ? -1 : x.txid > y.txid ? 1 : 0));
  }

  /** One pool's hops in its history order (at, then swaps). */
  poolHops(poolId: string): Hop[] {
    return this.hops.filter((h) => h.poolId === poolId).sort((x, y) => x.at - y.at || x.swaps - y.swaps);
  }

  /** Every pool id seen. */
  poolIds(): string[] { return [...new Set(this.hops.map((h) => h.poolId).concat([...this.current.keys()]))].sort(); }
}
