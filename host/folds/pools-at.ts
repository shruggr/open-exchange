// `/pools/at?t=` (amm-lookup 0.48.1 `poolsAt`): every pool listed at t — each pool's state after the last hop of its
// history standing at t (a deploy's or a swap's; a close or a rescind: not listed; none: not yet deployed), in pool id
// order. 0.25.0 (David 2026-11-11: a pool follows its EVENT ORDER, never the timestamp label — a spend is admitted only
// after all its parents): each pool's hops are walked in event order and the walk stops at its first hop with `at > t`
// (later hops of that pool are not looked at).
// 2026-11-12: one query on the analytics store (host/analytics.ts `poolsAt`, a window over each pool's events).
import type { Analytics } from "../analytics.ts";
import { poolFields } from "./hop.ts";
import type { Rec } from "../events.ts";

export function poolsAt(a: Analytics, tokenId: string, t: number): Rec[] {
  return a.poolsAt(tokenId, t).map(poolFields);
}
