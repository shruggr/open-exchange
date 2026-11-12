// The host's analytics store (David 2026-11-12, plans/host-analytics-store-settled-2026-11-12.md): the swap data the host
// derives from each token instance's `amm/hop` events, in its OWN SQLite database (`analytics.sqlite` in the host home,
// beside host.db and store.sqlite; one for the whole exchange), relational, read by query. Nothing about swaps is held
// in memory. It is derived data: filled by replaying the events, the last event place taken kept per token instance
// (`heads`), so a restart continues after it. Tables made with CREATE TABLE IF NOT EXISTS; nothing else.
//
//   hops(token_id, s, i, place, kind, txid, pool_id, outpoint, at, side, row)   one row per STANDING hop (a revert row
//        is not one: it removes every row whose txid it names); `row` the record as emitted, JSON with its exact
//        integers (amounts past 2^53 as written); sums and price math are the host's, in bigint, from `row`.
//   pools_now(token_id, pool_id, place, kind, outpoint, row)   each pool's latest hop (its state now): set by every hop
//        and by a revert row (the pool as it stands after the undo); a revert with no outpoint removes it.
//   heads(token_id, place)   the last event place taken from the instance; written in the same transaction as the rows.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { hopOf, type Hop } from "./folds/hop.ts";
import { toJson } from "./pools.ts";
import type { Rec } from "./events.ts";

/** The file's name in the host home. */
export const ANALYTICS_FILE = "analytics.sqlite";

const DDL = `
CREATE TABLE IF NOT EXISTS hops (
  token_id TEXT NOT NULL, s INTEGER NOT NULL, i INTEGER NOT NULL, place TEXT NOT NULL,
  kind TEXT NOT NULL, txid TEXT NOT NULL, pool_id TEXT NOT NULL, outpoint TEXT, at INTEGER NOT NULL, side TEXT,
  row TEXT NOT NULL,
  PRIMARY KEY (token_id, s, i)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS hops_txid ON hops (token_id, txid);
CREATE INDEX IF NOT EXISTS hops_pool ON hops (token_id, pool_id, s, i);
CREATE INDEX IF NOT EXISTS hops_at ON hops (token_id, at);
CREATE INDEX IF NOT EXISTS hops_outpoint ON hops (token_id, outpoint);
CREATE INDEX IF NOT EXISTS hops_pool_at ON hops (pool_id, at);
CREATE TABLE IF NOT EXISTS pools_now (
  token_id TEXT NOT NULL, pool_id TEXT NOT NULL, place TEXT NOT NULL, kind TEXT NOT NULL, outpoint TEXT, row TEXT NOT NULL,
  PRIMARY KEY (token_id, pool_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS heads (token_id TEXT PRIMARY KEY, place TEXT NOT NULL) WITHOUT ROWID;
`;

/** A stored row's JSON back as a value: integers past 2^53 as bigint (as host/events.ts `record` reads them). */
function parseRow(text: string): Rec {
  return JSON.parse(text, (_k, x: unknown, ctx?: { source?: string }) =>
    typeof x === "number" && Number.isInteger(x) && !Number.isSafeInteger(x) && ctx?.source && /^-?\d+$/.test(ctx.source) ? BigInt(ctx.source) : x) as Rec;
}

/** An event place's step and index (`<s>.<i>.<thread>`). */
const si = (place: string): [number, number] => { const p = place.split("."); return [Number(p[0]), Number(p[1])]; };

type Row = { row: string; place: string };
const hop = (r: Row): Hop => hopOf(parseRow(r.row), r.place)!;

export interface TradesQuery { before?: string; from?: number; to?: number; pool?: string; limit: number }
export interface HistoryQuery { after?: string; from?: number; to?: number; pool?: string; limit: number }

export class Analytics {
  private readonly db: DatabaseSync;
  private readonly q: Record<string, StatementSync>;

  /** Open (and make) the database at `path` (`:memory:` for tests). */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 60000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(DDL);
    const d = this.db;
    this.q = {
      head: d.prepare("SELECT place FROM heads WHERE token_id = ?"),
      setHead: d.prepare("INSERT INTO heads (token_id, place) VALUES (?, ?) ON CONFLICT (token_id) DO UPDATE SET place = excluded.place"),
      put: d.prepare("INSERT INTO hops (token_id, s, i, place, kind, txid, pool_id, outpoint, at, side, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      dropTx: d.prepare("DELETE FROM hops WHERE token_id = ? AND txid = ?"),
      setNow: d.prepare("INSERT INTO pools_now (token_id, pool_id, place, kind, outpoint, row) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (token_id, pool_id) DO UPDATE SET place = excluded.place, kind = excluded.kind, outpoint = excluded.outpoint, row = excluded.row"),
      dropNow: d.prepare("DELETE FROM pools_now WHERE token_id = ? AND pool_id = ?"),
      standing: d.prepare("SELECT 1 AS x FROM hops WHERE token_id = ? AND txid = ? LIMIT 1"),
      lastSwap: d.prepare("SELECT row, place FROM hops WHERE token_id = ? AND kind = 'swap' ORDER BY s DESC, i DESC LIMIT 1"),
      swaps: d.prepare("SELECT row, place FROM hops WHERE token_id = ? AND kind = 'swap' ORDER BY s, i"),
      poolSwaps: d.prepare("SELECT row, place FROM hops WHERE token_id = ? AND pool_id = ? AND kind = 'swap' ORDER BY s, i"),
      byMinute: d.prepare("SELECT row, place FROM hops WHERE token_id = ? AND kind = 'swap' AND at >= ? AND at < ? ORDER BY at - (at % 60000), s, i"),
      madeBy: d.prepare("SELECT pool_id, place FROM hops WHERE token_id = ? AND outpoint = ? ORDER BY s, i LIMIT 1"),
      live: d.prepare("SELECT row, place FROM pools_now WHERE token_id = ? AND outpoint IS NOT NULL AND kind NOT IN ('close', 'rescind') ORDER BY outpoint"),
      now: d.prepare("SELECT row, place FROM pools_now WHERE token_id = ? ORDER BY pool_id"),
      all: d.prepare("SELECT row, place FROM hops WHERE token_id = ? ORDER BY s, i"),
      // `/pools/at`: per pool, its hops in event order up to (not including) its first with at > t; the last of those.
      at: d.prepare(`SELECT row, place FROM (
          SELECT row, place, kind, pool_id, ROW_NUMBER() OVER (PARTITION BY pool_id ORDER BY s DESC, i DESC) AS n FROM (
            SELECT row, place, kind, pool_id, s, i, MAX(at > ?2) OVER (PARTITION BY pool_id ORDER BY s, i ROWS UNBOUNDED PRECEDING) AS stopped
            FROM hops WHERE token_id = ?1)
          WHERE stopped = 0)
        WHERE n = 1 AND kind IN ('deploy', 'swap') ORDER BY pool_id`),
    };
  }

  /** The last event place taken from `tokenId`'s instance, or undefined (none yet: from zero). */
  head(tokenId: string): string | undefined {
    return (this.q.head!.get(tokenId) as { place: string } | undefined)?.place;
  }

  /**
   * One `amm/hop` event at its place, in ONE transaction with the head: a hop's row stored and its pool's state set; a
   * revert's every row of its txid removed and its pool set to the revert row (no outpoint: removed). Returns the hop,
   * or undefined when the record is not one (the head still moves past it).
   */
  take(tokenId: string, rec: Rec, place: string): Hop | undefined {
    const h = hopOf(rec, place);
    const q = this.q;
    this.db.exec("BEGIN");
    try {
      if (h) {
        const row = toJson(h.row);
        if (h.kind === "revert") q.dropTx!.run(tokenId, h.txid);
        else { const [s, i] = si(place); q.put!.run(tokenId, s, i, place, h.kind, h.txid, h.poolId, h.outpoint ?? null, h.at, h.side ?? null, row); }
        if (h.kind === "revert" && !h.outpoint) q.dropNow!.run(tokenId, h.poolId);
        else q.setNow!.run(tokenId, h.poolId, place, h.kind, h.outpoint ?? null, row);
      }
      q.setHead!.run(tokenId, place);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return h;
  }

  /** Whether a hop of `txid` stands. */
  standing(tokenId: string, txid: string): boolean { return this.q.standing!.get(tokenId, txid) !== undefined; }

  /** The swaps newest EVENT first, strictly before the place `before`, filtered by own `at` and pool; at most `limit`. */
  trades(tokenId: string, o: TradesQuery): Hop[] {
    const where = ["token_id = ?", "kind = 'swap'"];
    const args: Array<string | number> = [tokenId];
    if (o.before !== undefined) { const [s, i] = si(o.before); where.push("(s < ? OR (s = ? AND i < ?))"); args.push(s, s, i); }
    if (o.from !== undefined) { where.push("at >= ?"); args.push(o.from); }
    if (o.to !== undefined) { where.push("at < ?"); args.push(o.to); }
    if (o.pool !== undefined) { where.push("pool_id = ?"); args.push(o.pool); }
    args.push(o.limit);
    return (this.db.prepare(`SELECT row, place FROM hops WHERE ${where.join(" AND ")} ORDER BY s DESC, i DESC LIMIT ?`).all(...args) as Row[]).map(hop);
  }

  /** The standing hops oldest EVENT first, strictly after `after`, filtered by own `at` and pool; at most `limit`. */
  history(tokenId: string, o: HistoryQuery): Hop[] {
    const where = ["token_id = ?"];
    const args: Array<string | number> = [tokenId];
    if (o.after !== undefined) { const [s, i] = si(o.after); where.push("(s > ? OR (s = ? AND i > ?))"); args.push(s, s, i); }
    if (o.from !== undefined) { where.push("at >= ?"); args.push(o.from); }
    if (o.to !== undefined) { where.push("at < ?"); args.push(o.to); }
    if (o.pool !== undefined) { where.push("pool_id = ?"); args.push(o.pool); }
    args.push(o.limit);
    return (this.db.prepare(`SELECT row, place FROM hops WHERE ${where.join(" AND ")} ORDER BY s, i LIMIT ?`).all(...args) as Row[]).map(hop);
  }

  /** The swaps with lo ≤ at < hi, by minute of `at`, within a minute in event order. */
  swapsByMinute(tokenId: string, lo: number, hi: number): Hop[] { return (this.q.byMinute!.all(tokenId, lo, hi) as Row[]).map(hop); }

  /** The last swap event. */
  lastSwap(tokenId: string): Hop | undefined { const r = this.q.lastSwap!.get(tokenId) as Row | undefined; return r ? hop(r) : undefined; }

  /** Every standing swap of the token (or of one pool), in event order. */
  swaps(tokenId: string, poolId?: string): Hop[] {
    return ((poolId === undefined ? this.q.swaps!.all(tokenId) : this.q.poolSwaps!.all(tokenId, poolId)) as Row[]).map(hop);
  }

  /** The first standing hop that made `outpoint` (`<txid>_<vout>`): its pool and place. */
  madeBy(tokenId: string, outpoint: string): { poolId: string; place: string } | undefined {
    const r = this.q.madeBy!.get(tokenId, outpoint) as { pool_id: string; place: string } | undefined;
    return r ? { poolId: r.pool_id, place: r.place } : undefined;
  }

  /** The listed pools now (live: an outpoint, not closed or rescinded): their latest hops, in outpoint order. */
  livePools(tokenId: string): Hop[] { return (this.q.live!.all(tokenId) as Row[]).map(hop); }

  /** Each pool's latest hop, whatever its status, in pool id order. */
  poolsNow(tokenId: string): Hop[] { return (this.q.now!.all(tokenId) as Row[]).map(hop); }

  /** Every standing hop, in event order. */
  hops(tokenId: string): Hop[] { return (this.q.all!.all(tokenId) as Row[]).map(hop); }

  /** Each pool's last hop standing at `t` when it is a deploy or a swap (the walk stops at its first hop with at > t), in pool id order. */
  poolsAt(tokenId: string, t: number): Hop[] { return (this.q.at!.all(tokenId, t) as Row[]).map(hop); }

  /** The swaps of these pools (any token) with from ≤ at < to (each bound optional), with their token, in event order. */
  poolSwaps(poolIds: string[], from?: number, to?: number): Array<{ tokenId: string; hop: Hop }> {
    if (poolIds.length === 0) return [];
    const where = [`pool_id IN (${poolIds.map(() => "?").join(", ")})`, "kind = 'swap'"];
    const args: Array<string | number> = [...poolIds];
    if (from !== undefined) { where.push("at >= ?"); args.push(from); }
    if (to !== undefined) { where.push("at < ?"); args.push(to); }
    const rows = this.db.prepare(`SELECT token_id, row, place FROM hops WHERE ${where.join(" AND ")} ORDER BY token_id, s, i`).all(...args) as Array<Row & { token_id: string }>;
    return rows.map((r) => ({ tokenId: r.token_id, hop: hop(r) }));
  }

  close(): void { this.db.close(); }
}
