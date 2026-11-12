// `/trades` (amm-p2p 0.48.1 H1, the host's from 0.21.0): `?txid=` one row (host/pools.ts: the latest `amm/output/<txid>.0`, 404 none); else `?from&to&limit(≤500)&before=<place>&pool=`, the
// page newest first, `next` the last row's place when the page is full. A row: txid, poolId, lpPubKey, side,
// amountIn, amountOut, feeLp, feeValidator, feeCommission, bsvReserve, tokenReserve, payoutPkh, at, height (the
// block height its `chain/tx/<txid>` names when mined, else null — `heightOf`).
// 0.25.0 (David 2026-11-11: trades in EVENT order, never re-sorted by time): newest first = the fold's swaps read from
// the last event back; `before` = an event place (`<s>.<i>.<thread>`, the rows strictly before it; an older cursor
// is refused); `pool` and `from ≤ at < to` (each row's own `at`) filter that order.
// 2026-11-12: read from the analytics store (host/analytics.ts `trades`: ORDER BY s DESC, i DESC).
import type { Analytics } from "../analytics.ts";
import { PLACE, type Hop } from "./hop.ts";
import type { Rec } from "../events.ts";

export const MAX_TRADES = 500;
/** The page size with no `limit` (amm-lookup `TradeQuery` default). */
export const DEFAULT_TRADES = 100;

export class BadQuery extends Error {}

export function tradeRow(h: Hop, height: number | null): Rec {
  return {
    txid: h.txid, poolId: h.poolId, lpPubKey: h.lpPubKey, side: h.side,
    amountIn: h.amountIn, amountOut: h.amountOut, feeLp: h.feeLp, feeValidator: h.feeValidator, feeCommission: h.feeCommission,
    bsvReserve: h.bsvReserve, tokenReserve: h.tokenReserve, payoutPkh: h.payoutPkh ?? "", at: h.at, height,
  };
}

export type HeightOf = (txid: string) => Promise<number | null>;

export async function trades(a: Analytics, tokenId: string, q: URLSearchParams, heightOf: HeightOf): Promise<{ trades: Rec[]; next: string | null }> {
  const int = (k: string) => { const v = q.get(k); if (v === null) return undefined; if (!/^\d+$/.test(v)) throw new BadQuery(`${k}: an integer`); return Number(v); };
  const from = int("from"), to = int("to");
  const limit = int("limit") ?? DEFAULT_TRADES;
  if (limit === 0 || limit > MAX_TRADES) throw new BadQuery(`limit: 1 to ${MAX_TRADES}`);
  const pool = q.get("pool");
  if (pool !== null && !/^[0-9a-f]{64}_\d+$/.test(pool)) throw new BadQuery("pool: <txid>_<vout>");
  const before = q.get("before");
  if (before !== null && !PLACE.test(before)) throw new BadQuery("before: an event place <s>.<i>.<thread> (a page's `next`)");
  const rows = a.trades(tokenId, { limit, ...(before !== null ? { before } : {}), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(pool !== null ? { pool } : {}) });
  return { trades: await Promise.all(rows.map(async (h) => tradeRow(h, await heightOf(h.txid)))), next: rows.length === limit ? rows[rows.length - 1]!.place : null };
}
