// `/trades` (amm-p2p 0.48.1 H1, the host's from 0.21.0): `?txid=` one row (host/pools.ts: the latest `amm/output/<txid>.0`, 404 none); else `?from&to&limit(≤500)&before=<cursor>&pool=`, the
// page newest first, `next` the last row's cursor when the page is full. A row: txid, poolId, lpPubKey, side,
// amountIn, amountOut, feeLp, feeValidator, feeCommission, bsvReserve, tokenReserve, payoutPkh, at, height (the
// block height its `chain/tx/<txid>` names when mined, else null — `heightOf`).
import type { TokenFold } from "./fold.ts";
import type { Hop } from "./hop.ts";
import type { Rec } from "../events.ts";

export const MAX_TRADES = 500;
/** The page size with no `limit` (amm-lookup `TradeQuery` default). */
export const DEFAULT_TRADES = 100;

export class BadQuery extends Error {}

/** A cursor: hex of `<at>:<txid>` (opaque to a client). */
const cursorOf = (h: Hop) => Buffer.from(`${h.at}:${h.txid}`).toString("hex");
function parseCursor(t: string): { at: number; txid: string } {
  const m = /^(\d+):([0-9a-f]{64})$/.exec(Buffer.from(t, "hex").toString());
  if (!/^[0-9a-f]+$/.test(t) || !m) throw new BadQuery("before: not a cursor of this read");
  return { at: Number(m[1]), txid: m[2]! };
}

export function tradeRow(h: Hop, height: number | null): Rec {
  return {
    txid: h.txid, poolId: h.poolId, lpPubKey: h.lpPubKey, side: h.side,
    amountIn: h.amountIn, amountOut: h.amountOut, feeLp: h.feeLp, feeValidator: h.feeValidator, feeCommission: h.feeCommission,
    bsvReserve: h.bsvReserve, tokenReserve: h.tokenReserve, payoutPkh: h.payoutPkh ?? "", at: h.at, height,
  };
}

export type HeightOf = (txid: string) => Promise<number | null>;

export async function trades(f: TokenFold, q: URLSearchParams, heightOf: HeightOf): Promise<{ trades: Rec[]; next: string | null }> {
  const int = (k: string) => { const v = q.get(k); if (v === null) return undefined; if (!/^\d+$/.test(v)) throw new BadQuery(`${k}: an integer`); return Number(v); };
  const from = int("from"), to = int("to");
  const limit = int("limit") ?? DEFAULT_TRADES;
  if (limit === 0 || limit > MAX_TRADES) throw new BadQuery(`limit: 1 to ${MAX_TRADES}`);
  const pool = q.get("pool");
  if (pool !== null && !/^[0-9a-f]{64}_\d+$/.test(pool)) throw new BadQuery("pool: <txid>_<vout>");
  const before = q.get("before") ? parseCursor(q.get("before")!) : undefined;
  const rows = f.swaps().filter((h) =>
    (from === undefined || h.at >= from) && (to === undefined || h.at < to) && (pool === null || h.poolId === pool) &&
    (!before || h.at < before.at || (h.at === before.at && h.txid < before.txid))).reverse().slice(0, limit);
  return { trades: await Promise.all(rows.map(async (h) => tradeRow(h, await heightOf(h.txid)))), next: rows.length === limit ? cursorOf(rows[rows.length - 1]!) : null };
}
