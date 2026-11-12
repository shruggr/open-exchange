// `/pools/history?from&to&pool&limit&after&outpoint` (0.21.0, the recognizer's order): the standing hop rows oldest first
// in the instance's event order, `from ≤ at < to`, one pool or every pool; forward paging with `after` = an event place
// (the rows strictly after it), `limit` ≤ 500, `next` the last row's place when more rows remain, else null;
// `outpoint=` a wallet's pool output: its pool, strictly after the place of its latest `amm/output/<op>` row (the caller
// reads it: `start`). Each row the hop's record as emitted. 0.25.0 (David 2026-11-11): the rows in EVENT order, never
// re-sorted; `from`/`to` judge each row on its own `at`.
// 2026-11-12: read from the analytics store (host/analytics.ts `history`: ORDER BY s, i).
import type { Analytics } from "../analytics.ts";
import { PLACE } from "./hop.ts";
import { BadQuery } from "./trades.ts";
import type { Rec } from "../events.ts";

export const MAX_EVENTS = 500;

export class NotFound extends Error {}

/** `start`: the `outpoint=` row's pool and place (the latest `amm/output/<op>`), or undefined when there is none. */
export function poolHistory(a: Analytics, tokenId: string, q: URLSearchParams, start?: { poolId: string; place: string } | null): { events: Rec[]; next: string | null } {
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
  const rows = a.history(tokenId, { limit: limit + 1, ...(after !== null ? { after } : {}), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(pool !== null ? { pool } : {}) });
  const page = rows.slice(0, limit);
  return { events: page.map((h) => h.row), next: rows.length > limit ? page[page.length - 1]!.place : null };
}
