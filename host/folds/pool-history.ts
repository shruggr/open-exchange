// `/pools/history?from&to&pool&limit&after&outpoint` (0.21.0, the recognizer's order): the standing hop rows oldest first
// in the instance's event order, `from ≤ at < to`, one pool or every pool; forward paging with `after` = an event place
// (the rows strictly after it), `limit` ≤ 500, `next` the last row's place when more rows remain, else null;
// `outpoint=` a wallet's pool output: its pool, strictly after the place of its latest `amm/output/<op>` row (the caller
// reads it: `start`). Each row the hop's record as emitted. 0.24.0: `from`/`to` judge a hop's EFFECTIVE time (fold.ts
// `effectiveAt`, the greatest `at` up to it in its pool's history; `at` itself where it rises), as `/pools/at` does,
// so `?pool&to=t` is exactly the prefix `/pools/at?t=<t-1>` stands on; the rows stay in place order.
import type { TokenFold } from "./fold.ts";
import { PLACE, placeCmp } from "./hop.ts";
import { BadQuery } from "./trades.ts";
import type { Rec } from "../events.ts";

export const MAX_EVENTS = 500;

export class NotFound extends Error {}

/** `start`: the `outpoint=` row's pool and place (the latest `amm/output/<op>`), or undefined when there is none. */
export function poolHistory(f: TokenFold, q: URLSearchParams, start?: { poolId: string; place: string } | null): { events: Rec[]; next: string | null } {
  const int = (k: string) => { const v = q.get(k); if (v === null) return undefined; if (!/^\d+$/.test(v)) throw new BadQuery(`${k}: an integer`); return Number(v); };
  const from = int("from"), to = int("to");
  const limit = int("limit") ?? MAX_EVENTS;
  if (limit === 0 || limit > MAX_EVENTS) throw new BadQuery(`limit: 1 to ${MAX_EVENTS}`);
  let pool = q.get("pool");
  if (pool !== null && !/^[0-9a-f]{64}_\d+$/.test(pool)) throw new BadQuery("pool: <txid>_<vout>");
  let after = q.get("after");
  if (after !== null && !PLACE.test(after)) throw new BadQuery("after: an event place <s>.<i>.<thread> (skein 0.8.0)");
  if (q.get("outpoint") !== null) {
    if (!start) throw new NotFound("no pool output at this outpoint");
    pool = start.poolId;
    after = start.place;
  }
  const eff = f.effectiveAt();
  const rows = f.hops.filter((h) => (pool === null || h.poolId === pool) && (from === undefined || eff.get(h)! >= from) && (to === undefined || eff.get(h)! < to) && (after === null || placeCmp(after, h.place) < 0))
    .sort((x, y) => placeCmp(x.place, y.place));
  const page = rows.slice(0, limit);
  return { events: page.map((h) => h.row), next: rows.length > limit ? page[page.length - 1]!.place : null };
}
