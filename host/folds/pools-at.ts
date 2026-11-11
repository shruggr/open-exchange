// `/pools/at?t=` (amm-lookup 0.48.1 `poolsAt`): every pool listed at t — each pool's last hop at or before t (in its
// history order), a deploy's or a swap's (a close or a rescind: not listed; none: not yet deployed), in pool id order.
// 0.24.0 (skein-amm 0.52.0: `at` is a block's time or a step's, not monotonic along a pool's history): "at or before t"
// is judged on the hop's EFFECTIVE time (fold.ts `effectiveAt`, the greatest `at` up to it in its history), so the
// answer is always a prefix of the pool's history — the state after the last hop of the longest prefix whose every
// `at` is ≤ t — never a later state whose predecessor had not happened by t.
import type { TokenFold } from "./fold.ts";
import { poolFields } from "./hop.ts";
import type { Rec } from "../events.ts";

export function poolsAt(f: TokenFold, t: number): Rec[] {
  const out: Rec[] = [];
  const eff = f.effectiveAt();
  for (const id of f.poolIds()) {
    const hops = f.poolHops(id).filter((h) => eff.get(h)! <= t);
    const last = hops[hops.length - 1];
    if (last && (last.kind === "deploy" || last.kind === "swap")) out.push(poolFields(last));
  }
  return out;
}
