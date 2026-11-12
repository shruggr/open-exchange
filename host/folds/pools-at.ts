// `/pools/at?t=` (amm-lookup 0.48.1 `poolsAt`): every pool listed at t — each pool's state after the last hop of its
// history standing at t (a deploy's or a swap's; a close or a rescind: not listed; none: not yet deployed), in pool id
// order. 0.25.0 (David 2026-11-11: a pool follows its EVENT ORDER, never the timestamp label — a spend is admitted only
// after all its parents): each pool's hops are walked in event order and the walk stops at its first hop with `at > t`
// (later hops of that pool are not looked at).
import type { TokenFold } from "./fold.ts";
import { poolFields, type Hop } from "./hop.ts";
import type { Rec } from "../events.ts";

export function poolsAt(f: TokenFold, t: number): Rec[] {
  const last = new Map<string, Hop>();
  const stopped = new Set<string>();
  for (const h of f.hops) {
    if (stopped.has(h.poolId)) continue;
    if (h.at > t) { stopped.add(h.poolId); continue; }
    last.set(h.poolId, h);
  }
  const out: Rec[] = [];
  for (const id of [...last.keys()].sort()) {
    const h = last.get(id)!;
    if (h.kind === "deploy" || h.kind === "swap") out.push(poolFields(h));
  }
  return out;
}
