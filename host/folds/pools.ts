// The live pool rows (amm-lookup 0.48.1 `{tokenId}` answer: `poolStateValue` = the pool fields and `lifetime`), from
// the analytics store (2026-11-12: each pool's latest hop, `pools_now`) — what the host's P1 / P2 join with the beats
// and the market minimum (host/pools.ts).
import type { Analytics } from "../analytics.ts";
import { poolFields } from "./hop.ts";
import { poolLifetime } from "./counters.ts";
import type { Rec } from "../events.ts";

export function livePoolRows(a: Analytics, tokenId: string): Rec[] {
  return a.livePools(tokenId).map((h) => ({ ...poolFields(h), lifetime: poolLifetime(a, tokenId, h.poolId) }));
}
