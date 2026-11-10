// `/pools/at?t=` (amm-lookup 0.48.1 `poolsAt`): every pool listed at t — each pool's last hop at or before t (in its
// history order), a deploy's or a swap's (a close or a rescind: not listed; none: not yet deployed), in pool id order.
import type { TokenFold } from "./fold.ts";
import { poolFields } from "./hop.ts";
import type { Rec } from "../events.ts";

export function poolsAt(f: TokenFold, t: number): Rec[] {
  const out: Rec[] = [];
  for (const id of f.poolIds()) {
    const hops = f.poolHops(id).filter((h) => h.at <= t);
    const last = hops[hops.length - 1];
    if (last && (last.kind === "deploy" || last.kind === "swap")) out.push(poolFields(last));
  }
  return out;
}
