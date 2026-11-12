// The Open Exchange's pool reads and pool event feeds (0.11.0, the public read API; plans: D11, D13, D22;
// 0.14.0: the pool id, the price, the validator minimum, the feeds), answered by the HOST through skein's
// Router option `appRead` — the routes that join what only the host holds (the beats it keeps per topic, every enabled
// token instance) to a token instance's pools. 0.21.0 (G2, David: every public read path and its JSON stays; the
// newest-first and aggregate reads are the host's, folded from the event stream): the pools, trades, candles, stats,
// /pools/at and /pools/history come from the host's FOLD (the instance keeps /positions) of each token instance's `amm/hop` events
// (host/folds, replayed from place zero at start, then live), no longer from the instance's lookup and read routes
// (2026-11-12: the fold is the host's analytics store, host/analytics.ts, a SQLite file; a start continues after the
// last place it took);
// the feeds from the same subscription, no longer `appEvent`:
//
//   GET /@<tokenId>/amm/pools   {market, validators: [{identity, peerId, minLegSats?}], pools: [{poolId, lpPubKey,
//                                outpoint, bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps, commissionBps,
//                                validatorIdentityKey, validatorPeerId, swaps, lifetime?}]}   a plain read (0.14.0: no event stream;
//                                0.19.0: `lifetime`, the pool lookup's counters for the pool, passed through)
//       the instance's live pools (0.21.0: the fold; was its lookup ls_amm_<tokenId>, {tokenId}) whose validator is beating
//       on tm_color_<tokenId>-live now (the host's liveness table; the peer ID is the beat's `from`) AND
//       whose commissionBps is at least the instance's market minimum; `market` = the instance's own
//       minimum (GET /amm/terms `market.minCommissionBps`) and its identity key (0.21.0: `market` =
//       {identityKey, minCommissionBps}; the commission key is per swap, keyed by the pool outpoint the swap
//       spends, derived from identityKey: host/relay.ts `commissionPkhFor`); `validators` = every
//       validator beating on tm_color_<tokenId>-live now (identity hex, peer ID the beat's `from`, and
//       0.14.0 `minLegSats` = the beat body's `terms.minLegSats` when its terms carry one), whatever its pools.
//   GET <origin>/amm/pools      [{tokenId, …the row above}]   every enabled token instance's, one array.
//   GET /@<tokenId>/amm/stats   the instance's own `/stats` row (0.20.0, skein-amm 0.48.0 D4: the last fill, the volumes
//                                and the counts only) with `tvlSats`, `tvlTokens` and `pools` the sums and
//                                the count over the pools GET /@<id>/amm/pools lists; 0.14.0: `price` = the engine's
//                                `priceOf(those pools).mid`, `buyPrice` / `sellPrice` its buy and sell (null with no
//                                pool); `change1h` / `change24h` = the change in bps (truncated toward zero) from
//                                `priceOf(GET /pools/at?t=now − 1 h | 24 h).mid` to `price` (null when either is none);
//                                `lastTradePrice`, the volumes, `lastTradeAt` the instance's.
//   GET <origin>/amm/stats      [<a token's GET /@<id>/amm/stats>]   every enabled token's, one array; `?ids=a,b` those
//                                enabled tokens only, in the query's order.
//   GET /@<tokenId>/amm/candles?tf=&from=&to=   the fill candles from the fold's minute tallies (host/folds/candles.ts);
//                                `series=fill` the same; 0.25.0: `series=market` (the market-price series) removed —
//                                any other series is refused 400.
//   GET <origin>/amm/lp/fees?pool=id1,id2&from=<ms>&to=<ms>   (2026-11-12) the named pools' LP fees summed from the
//                                analytics store: {from, to, sats, tokens: [{tokenId, amount}], swaps, pools, byPool:
//                                [{poolId, tokenId, sats, tokens, swaps}]} (host/folds/lp-fees.ts).
//   GET <origin>/amm/positions?pool=id1,id2   [{tokenId, …a row of GET /@<id>/amm/positions?pool=}]   every enabled
//                                token's rows for the pool ids.
//   GET <origin>/amm/spends?outpoint=a,b      (0.14.0) [{outpoint, tokenId?, spentBy?}]   one record per outpoint in
//                                query order: each enabled token's `/spends`, the first that names a spender.
//   GET /@<tokenId>/amm/events, GET <origin>/amm/events   (0.14.0) Server-Sent Events: each message `event: pool`,
//                                `data: {"tokenId": …, …row}` — the token instance's emitted `pool` event (its
//                                lookup's, app `amm`: `{event: "pool", topic, tokenId, row}`), its `tokenId` and
//                                `row` passed through untouched; the token feed that token's, the origin feed every
//                                enabled token's. Nothing is sent on connect, nothing is kept, nothing is replayed:
//                                a connection is a subscriber in a set, removed when it closes.
//
// The reads: `Cache-Control: public, max-age=5`; a token whose read fails is left out of a join (logged).
import { priceOf, type PoolState, type PricePair as Price } from "@dcasegr/amm-engine";
import { SWAP } from "./exchange.ts";
import type { Router } from "./skein.ts";
import { Folds } from "./folds/index.ts";
import { livePoolRows } from "./folds/pools.ts";
import { instanceStats } from "./folds/stats.ts";
import { poolsAt } from "./folds/pools-at.ts";
import { NotFound, poolHistory } from "./folds/pool-history.ts";
import { BadQuery, tradeRow, trades } from "./folds/trades.ts";
import { hopOf } from "./folds/hop.ts";
import { latestDelivered } from "./events.ts";
import { candles } from "./folds/candles.ts";
import { lpFeesRead } from "./folds/lp-fees.ts";
import type { Analytics } from "./analytics.ts";

type RouterRequest = import("@dcasegr/skein/dist/host/router.js").RouterRequest;
type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;
type Rec = Record<string, unknown>;

const TOKEN_ID = /^[0-9a-f]{64}_\d+$/;
/** The token app's name (its routes are /amm/…, its events' `app`). */
const APP = "amm";
/** The routes the host answers (at the token instance's, at swap's). */
export const POOLS_ROUTE = `/${APP}/pools`;
export const STATS_ROUTE = `/${APP}/stats`;
export const POSITIONS_ROUTE = `/${APP}/positions`;
export const SPENDS_ROUTE = `/${APP}/spends`;
export const CANDLES_ROUTE = `/${APP}/candles`;
export const EVENTS_ROUTE = `/${APP}/events`;
/** 0.21.0 (G2): the instance reads the host now answers from its fold (the token instance drops them). */
export const TRADES_ROUTE = `/${APP}/trades`;
export const POOLS_AT_ROUTE = `/${APP}/pools/at`;
export const POOLS_HISTORY_ROUTE = `/${APP}/pools/history`;
/** 2026-11-12: the LP fees of named pools (at swap's, host-wide). */
export const LP_FEES_ROUTE = `/${APP}/lp/fees`;
/** The SSE message name the feeds send (today's, skein-amm 0.41.0: `event: pool`). */
export const POOL_EVENT = "pool";
const CACHE = "public, max-age=5";
const HOUR_MS = 3_600_000;

/** One pool as the routes answer it. */
export interface PoolRow {
  poolId: string; lpPubKey?: string; outpoint: string; bsvReserve: unknown; tokenReserve: unknown;
  liquidityFeeBps: unknown; validationFeeBps: unknown; commissionBps: unknown;
  validatorIdentityKey: string; validatorPeerId: string; swaps: unknown;
  /** 0.19.0 (skein-amm 0.47.0): the pool's counters, as the lookup's row carries them. */
  lifetime?: unknown;
}
export interface Market { identityKey: string; minCommissionBps?: unknown }
export interface Validator { identity: string; peerId: string; minLegSats?: number | bigint }
export interface TokenPools { market: Market; validators: Validator[]; pools: PoolRow[] }

const enc = (s: string) => new TextEncoder().encode(s);
/** JSON with bigints as JSON numbers, exactly (the price pairs exceed 2^53). */
export const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(x.toString()) : x);
const jsonAnswer = (status: number, v: unknown, headers: Record<string, string> = {}): RouterResponse =>
  ({ status, headers: { "content-type": "application/json", ...headers }, body: enc(toJson(v)) });
const problem = (status: number, description: string) => jsonAnswer(status, { status: "error", code: status === 404 ? "ERR_NOT_FOUND" : status === 400 ? "ERR_BAD_REQUEST" : "ERR_UNAVAILABLE", description });
const num = (v: unknown) => typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
const big = (v: unknown): bigint => { try { return typeof v === "bigint" ? v : BigInt(v as number | string); } catch { return 0n; } };

/** A pool row (a listed pool, a `/pools/at` row, a history event's pool) as the engine's PoolState. */
export function poolState(p: Rec): PoolState {
  return {
    outpoint: String(p.outpoint), bsvReserve: big(p.bsvReserve), tokenReserve: big(p.tokenReserve),
    liquidityFeeBps: big(p.liquidityFeeBps), validationFeeBps: big(p.validationFeeBps), commissionBps: big(p.commissionBps),
    validatorIdentityKey: String(p.validatorIdentityKey),
  };
}

/** The change from `then` to `now` in bps, truncated toward zero (the instance's `changeBps`). */
export function changeBps(then: Price, now: Price): bigint {
  const n = now.sats * then.tokens - then.sats * now.tokens;
  const d = then.sats * now.tokens;
  return d === 0n ? 0n : (n * 10_000n) / d;
}

/**
 * A token's stats row as this host answers it (0.14.0): the instance's `/stats` row with `tvlSats`, `tvlTokens`
 * and `pools` the sums and the count over `pools` (the listed pools), `price` / `buyPrice` / `sellPrice` =
 * `priceOf(pools)`'s mid / buy / sell (null with none), and `change1h` / `change24h` from the mids `then1h` /
 * `then24h` (the pools listed an hour and a day ago, `/pools/at`) to `price` (null when either is none).
 * 0.20.0 (skein-amm 0.48.0 D4): the instance's row carries only what the host does not recompute (the last
 * fill, the volumes, the counts); the answer keeps its fields and their order (the instance's first, the
 * host's own in the places the instance's row had them).
 */
export function mergeStats(row: Rec, pools: PoolRow[], then1h: Price | null, then24h: Price | null): Rec {
  let sats = 0n, tokens = 0n;
  for (const p of pools) { sats += big(p.bsvReserve); tokens += big(p.tokenReserve); }
  const now = priceOf(pools.map((p) => poolState(p as unknown as Rec)));
  const price = now?.mid ?? null;
  const { tokenId, lastTradePrice, volume24hSats, volume24hTokens, buys24h, sells24h, lastTradeAt, volumeSats, volumeTokens, trades, ...rest } = row;
  return {
    tokenId, lastTradePrice,
    change1h: price && then1h ? changeBps(then1h, price) : null,
    change24h: price && then24h ? changeBps(then24h, price) : null,
    volume24hSats, volume24hTokens, buys24h, sells24h, lastTradeAt,
    tvlSats: sats, tvlTokens: tokens, pools: pools.length,
    volumeSats, volumeTokens, trades,
    ...rest,
    price, buyPrice: now?.buy ?? null, sellPrice: now?.sell ?? null,
  };
}

class ReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** A feed's connection: one message out. */
type Subscriber = (chunk: string) => void;

export class Pools {
  readonly router: Router;
  readonly say: (line: string) => void;
  /** dag-cbor decode (a beat's body). */
  private readonly decode: (bytes: Uint8Array) => unknown;
  /** The feeds' subscribers: per token instance, and the origin's (every token's). */
  private readonly feeds = new Map<string, Set<Subscriber>>();
  private readonly everyFeed = new Set<Subscriber>();
  /** Every open feed's end (the host stops). */
  private readonly ends = new Set<() => void>();
  /** 0.21.0: the following of the token instances' `amm/hop` events (host/folds) into the analytics store. */
  readonly folds: Folds;
  /** 2026-11-12: the host's analytics store (host/analytics.ts). */
  readonly store: Analytics;

  constructor(router: Router, say: (line: string) => void, decode: (bytes: Uint8Array) => unknown, store: Analytics) {
    this.router = router; this.say = say; this.decode = decode; this.store = store;
    this.folds = new Folds(router, say, store);
    this.folds.onHop = (tokenId, h) => this.poolEvent(tokenId, h.row);
  }

  /** Follow every enabled token instance's hops now (the feeds hear them from the start). */
  async follow(): Promise<void> {
    await Promise.all(this.tokens().map((id) => this.folds.ensure(id).catch(() => undefined)));
  }

  /** The token instance caught up into the store (followed first when it is not). */
  private fold(id: string): Promise<void> { return this.folds.ensure(id); }

  /** RouterOptions.appRead: the token routes at a token instance; the joins and the origin feed at swap; anything else undefined (forwarded). */
  async appRead(handle: string, route: string, url: URL, _req: RouterRequest): Promise<RouterResponse | undefined> {
    const q = url.searchParams;
    if (handle === SWAP) {
      if (route === EVENTS_ROUTE) { void this.follow(); return this.feed(this.everyFeed); }
      if (route === POOLS_ROUTE) return jsonAnswer(200, await this.allPools(), { "cache-control": CACHE });
      if (route === STATS_ROUTE) return jsonAnswer(200, await this.allStats(q.get("ids")), { "cache-control": CACHE });
      if (route === POSITIONS_ROUTE) {
        const pool = q.get("pool");
        if (!pool) return problem(400, "want ?pool=<txid>_<vout>[,…]");
        return jsonAnswer(200, await this.allPositions(pool), { "cache-control": CACHE });
      }
      if (route === LP_FEES_ROUTE) {
        try { return jsonAnswer(200, lpFeesRead(this.store, q), { "cache-control": CACHE }); } catch (e) {
          if (e instanceof BadQuery) return problem(400, e.message);
          throw e;
        }
      }
      if (route === SPENDS_ROUTE) {
        const ops = (q.get("outpoint") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
        if (ops.length === 0) return problem(400, "want ?outpoint=<txid>.<vout>[,…]");
        return jsonAnswer(200, await this.allSpends(ops), { "cache-control": CACHE });
      }
      return undefined;
    }
    if (!TOKEN_ID.test(handle)) return undefined;
    if (route === EVENTS_ROUTE) {
      let set = this.feeds.get(handle);
      if (!set) { set = new Set(); this.feeds.set(handle, set); }
      void this.folds.ensure(handle).catch(() => undefined);
      return this.feed(set);
    }
    try {
      if (route === POOLS_ROUTE) return jsonAnswer(200, await this.tokenPools(handle), { "cache-control": CACHE });
      if (route === STATS_ROUTE) return jsonAnswer(200, await this.tokenStats(handle), { "cache-control": CACHE });
      if (route === CANDLES_ROUTE) {
        const series = q.get("series");
        if (series === null || series === "fill") { await this.fold(handle); return jsonAnswer(200, candles(this.store, handle, q), { "cache-control": CACHE }); }
        return problem(400, "series: fill");
      }
      if (route === TRADES_ROUTE) {
        await this.fold(handle);
        const h = (txid: string) => this.folds.heightOf(handle, txid);
        const txid = q.get("txid");
        if (txid !== null) {
          if (!/^[0-9a-f]{64}$/.test(txid)) return problem(400, "want ?txid=<txid>: 64 hex characters");
          // The recognizer's answer for one Swap: the latest `amm/output/<txid>.0` row (its continuation), standing.
          const got = await latestDelivered(this.router, handle, `amm/output/${txid}.0`).catch(() => undefined);
          const hop = got ? hopOf(got.rec, got.place) : undefined;
          const standing = hop && hop.kind === "swap" && hop.txid === txid && this.store.standing(handle, txid);
          return standing ? jsonAnswer(200, tradeRow(hop, await h(txid)), { "cache-control": CACHE }) : problem(404, "no trade for this txid");
        }
        return jsonAnswer(200, await trades(this.store, handle, q, h), { "cache-control": CACHE });
      }
      if (route === POOLS_AT_ROUTE) {
        const t = q.get("t");
        if (t === null || !/^\d+$/.test(t)) return problem(400, "want ?t=<ms>");
        await this.fold(handle);
        return jsonAnswer(200, poolsAt(this.store, handle, Number(t)), { "cache-control": CACHE });
      }
      if (route === POOLS_HISTORY_ROUTE) {
        const op = q.get("outpoint");
        await this.fold(handle);
        let start: { poolId: string; place: string } | null = null;
        if (op !== null) {
          // A wallet's pool output `<txid>_<vout>` (the recognizer names outputs `<txid>.<vout>`): its pool and the
          // place of the standing hop that made it (its `amm/output/<op>` row comes in the same step, BEFORE that hop
          // row, so "strictly after the output" is strictly after the hop).
          const m = /^([0-9a-f]{64})[_.](\d+)$/.exec(op);
          if (!m) return problem(400, "outpoint: <txid>_<vout>");
          start = this.store.madeBy(handle, `${m[1]}_${m[2]}`) ?? null;
        }
        return jsonAnswer(200, poolHistory(this.store, handle, q, start), { "cache-control": CACHE });
      }
    } catch (e) {
      if (e instanceof BadQuery) return problem(400, e.message);
      if (e instanceof NotFound) return problem(404, e.message);
      return problem(e instanceof ReadError ? e.status : 503, (e as Error).message);
    }
    return undefined;
  }

  /**
   * A hop folded live (0.21.0: from the fold's `amm/hop` subscription, no longer `appEvent`): passed to its token's feed
   * and the origin feed as today's message, `event: pool`, `data: {tokenId, …row}`.
   */
  poolEvent(tokenId: string, row: Rec): void {
    const chunk = `event: ${POOL_EVENT}\ndata: ${toJson({ tokenId, ...row })}\n\n`;
    for (const s of this.feeds.get(tokenId) ?? []) s(chunk);
    for (const s of this.everyFeed) s(chunk);
  }

  /** A feed's answer: held open; the connection a subscriber in `set` until it closes. */
  private feed(set: Set<Subscriber>): RouterResponse {
    return {
      status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }, body: new Uint8Array(),
      stream: (send, end) => {
        set.add(send);
        this.ends.add(end);
        return () => { set.delete(send); this.ends.delete(end); };
      },
    };
  }

  // ---------------------------------------------------------------- the reads

  /** An in-process request of the instance's own (`/@<handle>/amm/<path>`). */
  private async instanceRead(handle: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const r = this.router;
    const a = await r.dispatch({ method, url: `${r.origin()}/@${handle}/${APP}/${path}`, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? new Uint8Array() : enc(JSON.stringify(body)) });
    const text = new TextDecoder().decode(a.body);
    if (a.status !== 200) throw new ReadError(502, `${method} /@${handle}/${APP}/${path}: ${a.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /** The validators beating on the token's topic now: identity → {peerId, minLegSats?} (the beat's body's `terms`). */
  private beating(id: string): Map<string, Validator> {
    const out = new Map<string, Validator>();
    for (const b of this.router.p2p?.live.live(id, `tm_color_${id}-live`) ?? []) {
      const identity = b.sender.toLowerCase();
      let min: unknown;
      try { min = ((this.decode(b.body) as Rec | null)?.terms as Rec | undefined)?.minLegSats; } catch { min = undefined; }
      out.set(identity, { identity, peerId: b.from, ...(typeof min === "number" || typeof min === "bigint" ? { minLegSats: min } : {}) });
    }
    return out;
  }

  /** P2: the token's live pools at or above its market's minimum commission, the market, the validators. */
  async tokenPools(id: string): Promise<TokenPools> {
    await this.fold(id);
    const listed = livePoolRows(this.store, id);
    const terms = await this.instanceRead(id, "GET", "terms") as { market?: { minCommissionBps?: unknown } };
    const identityKey = (await this.router.hydrate(id)).identity;
    const market: Market = { identityKey, ...(terms?.market && typeof terms.market === "object" && terms.market.minCommissionBps !== undefined ? { minCommissionBps: terms.market.minCommissionBps } : {}) };
    const min = num(market.minCommissionBps);
    const live = this.beating(id);
    const pools: PoolRow[] = [];
    for (const p of listed) {
      const v = typeof p.validatorIdentityKey === "string" ? p.validatorIdentityKey.toLowerCase() : "";
      const val = live.get(v);
      if (val === undefined) continue;
      if (Number.isFinite(min) && !(num(p.commissionBps) >= min)) continue;
      pools.push({
        poolId: String(p.poolId),
        ...(typeof p.lpPubKey === "string" ? { lpPubKey: p.lpPubKey } : {}),
        outpoint: String(p.outpoint), bsvReserve: p.bsvReserve, tokenReserve: p.tokenReserve,
        liquidityFeeBps: p.liquidityFeeBps, validationFeeBps: p.validationFeeBps, commissionBps: p.commissionBps,
        validatorIdentityKey: v, validatorPeerId: val.peerId, swaps: p.swaps,
        ...(p.lifetime && typeof p.lifetime === "object" ? { lifetime: p.lifetime } : {}),
      });
    }
    return { market, validators: [...live.values()], pools };
  }

  /** The enabled token instances (host.db), as the reconcile names them: handles of the token id's shape. */
  private tokens(): string[] {
    return this.router.o.db.list("enabled").map((r) => r.handle).filter((h) => TOKEN_ID.test(h));
  }

  /** P1: every enabled token's pools, each row with its tokenId; a token whose read fails is left out (logged). */
  async allPools(): Promise<Array<{ tokenId: string } & PoolRow>> {
    const out: Array<{ tokenId: string } & PoolRow> = [];
    for (const id of this.tokens()) {
      try { for (const p of (await this.tokenPools(id)).pools) out.push({ tokenId: id, ...p }); } catch (e) { this.say(`${id}: pools: left out of /amm/pools: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The mid price of the pools listed at `t` (every listed pool, whatever its validator; the fold), or null. */
  private async midAt(id: string, t: number): Promise<Price | null> {
    await this.fold(id);
    return priceOf(poolsAt(this.store, id, t).map(poolState))?.mid ?? null;
  }

  /** A token's stats (0.14.0): the instance's row merged with the listed pools and their price (`mergeStats`). */
  async tokenStats(id: string): Promise<Rec> {
    const now = Date.now();
    const [row, answer, then1h, then24h] = await Promise.all([this.fold(id).then(() => instanceStats(this.store, id, now)), this.tokenPools(id), this.midAt(id, Math.max(0, now - HOUR_MS)), this.midAt(id, Math.max(0, now - 24 * HOUR_MS))]);
    return mergeStats(row, answer.pools, then1h, then24h);
  }

  /** The host-wide stats: each enabled token's (`ids`: those enabled tokens only, in its order). */
  async allStats(ids: string | null): Promise<unknown[]> {
    const enabled = this.tokens();
    const want = ids === null ? enabled : ids.split(",").map((x) => x.trim()).filter((x) => enabled.includes(x));
    const out: unknown[] = [];
    for (const id of want) {
      try { out.push(await this.tokenStats(id)); } catch (e) { this.say(`${id}: stats: left out of /amm/stats: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The host-wide positions: each enabled token's `/positions?pool=` rows, each with its tokenId. */
  async allPositions(pool: string): Promise<Array<{ tokenId: string } & Rec>> {
    const out: Array<{ tokenId: string } & Rec> = [];
    for (const id of this.tokens()) {
      try {
        const rows = await this.instanceRead(id, "GET", `positions?pool=${encodeURIComponent(pool)}`);
        if (Array.isArray(rows)) for (const r of rows as Rec[]) out.push({ tokenId: id, ...r });
      } catch (e) { this.say(`${id}: positions: left out of /amm/positions: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The host-wide spends (0.14.0): per outpoint, the first enabled token whose `/spends` names a spender. */
  async allSpends(outpoints: string[]): Promise<Array<{ outpoint: string; tokenId?: string; spentBy?: string }>> {
    const out = outpoints.map((outpoint) => ({ outpoint } as { outpoint: string; tokenId?: string; spentBy?: string }));
    for (const id of this.tokens()) {
      try {
        const a = await this.instanceRead(id, "GET", `spends?outpoint=${outpoints.map(encodeURIComponent).join(",")}`);
        const rows = (Array.isArray(a) ? a : [a]) as Rec[];
        rows.forEach((s, i) => {
          const r = out[i];
          if (r && !r.spentBy && typeof s?.spentBy === "string") { r.tokenId = id; r.spentBy = s.spentBy; }
        });
      } catch (e) { this.say(`${id}: spends: left out of /amm/spends: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The host stops: every open feed ends. */
  stop(): void {
    this.folds.stop();
    for (const end of [...this.ends]) end();
    this.ends.clear();
    this.feeds.clear();
    this.everyFeed.clear();
  }
}
