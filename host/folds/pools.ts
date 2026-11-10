// The live pool rows (amm-lookup 0.48.1 `{tokenId}` answer: `poolStateValue` = the pool fields and `lifetime`), from
// the fold — what the host's P1 / P2 join with the beats and the market minimum (host/pools.ts).
import type { TokenFold } from "./fold.ts";
import { poolFields } from "./hop.ts";
import { poolLifetime } from "./counters.ts";
import type { Rec } from "../events.ts";

export function livePoolRows(f: TokenFold): Rec[] {
  return f.live().map((h) => ({ ...poolFields(h), lifetime: poolLifetime(f, h.poolId) }));
}
