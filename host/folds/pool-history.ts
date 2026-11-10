// `/pools/history?from&to&pool&limit&after&outpoint` (amm-lookup 0.48.1 `poolHistory`): the hops with from ≤ at < to,
// of one pool or every pool, oldest first by (at, pool id, swaps); forward paging with `after` (strictly after that
// position), `limit` ≤ 500, `next` the last row's cursor when more rows remain, else null; `outpoint=` a wallet's pool
// output: its pool, strictly after its hop. Each row the hop's record as emitted (THE history row).
import type { TokenFold } from "./fold.ts";
import type { Hop } from "./hop.ts";
import { BadQuery } from "./trades.ts";
import type { Rec } from "../events.ts";

export const MAX_EVENTS = 500;

type Pos = { at: number; poolId: string; seq: number };
const posOf = (h: Hop): Pos => ({ at: h.at, poolId: h.poolId, seq: h.swaps });
const lt = (x: Pos, y: Pos) => x.at !== y.at ? x.at < y.at : x.poolId !== y.poolId ? x.poolId < y.poolId : x.seq < y.seq;
const cursorText = (p: Pos) => Buffer.from(`${p.at}:${p.poolId}:${p.seq}`).toString("hex");
function parseCursor(t: string): Pos {
  const m = /^(\d+):([0-9a-f]{64}_\d+):(\d+)$/.exec(/^[0-9a-f]+$/.test(t) ? Buffer.from(t, "hex").toString() : "");
  if (!m) throw new BadQuery("after: not a cursor of this read");
  return { at: Number(m[1]), poolId: m[2]!, seq: Number(m[3]) };
}

export class NotFound extends Error {}

export function poolHistory(f: TokenFold, q: URLSearchParams): { events: Rec[]; next: string | null } {
  const int = (k: string) => { const v = q.get(k); if (v === null) return undefined; if (!/^\d+$/.test(v)) throw new BadQuery(`${k}: an integer`); return Number(v); };
  const from = int("from"), to = int("to");
  const limit = int("limit") ?? MAX_EVENTS;
  if (limit === 0 || limit > MAX_EVENTS) throw new BadQuery(`limit: 1 to ${MAX_EVENTS}`);
  let pool = q.get("pool");
  if (pool !== null && !/^[0-9a-f]{64}_\d+$/.test(pool)) throw new BadQuery("pool: <txid>_<vout>");
  let after = q.get("after") ? parseCursor(q.get("after")!) : undefined;
  const op = q.get("outpoint");
  if (op !== null) {
    const h = f.hops.find((x) => x.outpoint === op);
    if (!h) throw new NotFound("no pool output at this outpoint");
    pool = h.poolId;
    after = posOf(h);
  }
  const rows = f.hops.filter((h) => h.kind !== "revert" && (pool === null || h.poolId === pool) && (from === undefined || h.at >= from) && (to === undefined || h.at < to) && (!after || lt(after, posOf(h))))
    .sort((x, y) => (lt(posOf(x), posOf(y)) ? -1 : lt(posOf(y), posOf(x)) ? 1 : 0));
  const page = rows.slice(0, limit);
  return { events: page.map((h) => h.row), next: rows.length > limit ? cursorText(posOf(page[page.length - 1]!)) : null };
}
