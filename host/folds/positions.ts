// `/positions?pool=a,b` (amm-lookup `{poolIds}`, 0.40.0): per pool id `{poolId, lpPubKey, status, outpoint?, current?,
// sats, tokens, swaps}` — the LP fees of its swaps and its state; an unknown id `closed`, zeros, lpPubKey null.
import type { TokenFold } from "./fold.ts";
import { poolFields } from "./hop.ts";
import { lpFees, poolLifetime } from "./counters.ts";
import type { Rec } from "../events.ts";

export function positions(f: TokenFold, poolIds: string[]): Rec[] {
  return poolIds.map((poolId) => {
    const hops = f.poolHops(poolId);
    const last = hops[hops.length - 1] ?? f.current.get(poolId);
    const status = f.status(poolId);
    const cur = f.current.get(poolId);
    const sum = lpFees(hops);
    return {
      poolId,
      lpPubKey: last?.lpPubKey ?? null,
      ...(status !== "closed" && cur?.outpoint ? { outpoint: cur.outpoint, current: { ...poolFields(cur), lifetime: poolLifetime(f, poolId) } } : {}),
      status,
      sats: sum.sats, tokens: sum.tokens, swaps: sum.swaps,
    };
  });
}
