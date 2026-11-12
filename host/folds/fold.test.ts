// The folds (0.25.0, David 2026-11-11; 2026-11-12 over the analytics store, host/analytics.ts, a `:memory:` database):
// the hops stay in EVENT order, nothing re-sorts them; the candles come from the per-minute tallies (open / close
// within a minute by event order, a rollback works its minute out again); /trades newest first in event order with a place cursor; /stats' 24 h from the tallies; /pools/at walks a
// pool's events in order and stops at the first with `at > t`; /pools/history filters each row on its own `at`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics } from "../analytics.ts";
import { Folds } from "./index.ts";
import type { Hop } from "./hop.ts";
import { BadQuery, trades } from "./trades.ts";
import { candles, minuteOf, window } from "./candles.ts";
import { instanceStats, DAY_MS } from "./stats.ts";
import { poolsAt } from "./pools-at.ts";
import { poolHistory } from "./pool-history.ts";
import { Pools } from "../pools.ts";
import type { Router } from "../skein.ts";
import type { Rec } from "../events.ts";
import { SWAP } from "../exchange.ts";

const TOKEN = `${"ee".repeat(32)}_0`;
const POOL = `${"aa".repeat(32)}_0`;
const tx = (c: string) => c.repeat(64);
const T0 = 1_793_000_040_000; // a minute's start (a multiple of 60 000)

/** A hop row as the recognizer emits it (the fields the folds read). */
function row(type: string, txid: string, at: number, swaps: number, x: Rec = {}): Rec {
  return {
    type, txid, tokenId: TOKEN, poolId: POOL, outpoint: `${txid}_0`, bsvReserve: 1000 + swaps, tokenReserve: 5000 - swaps,
    lpPubKey: "02" + "11".repeat(32), liquidityFeeBps: 30, validationFeeBps: 0, commissionBps: 0, validatorIdentityKey: "02" + "22".repeat(32),
    at, swaps, ...x,
  };
}
const buy = (sats: number, tokens: number): Rec => ({ side: "buy", amountIn: sats, amountOut: tokens, feeLp: 0, feeValidator: 0, feeCommission: 0 });
const sell = (tokens: number, sats: number): Rec => ({ side: "sell", amountIn: tokens, amountOut: sats, feeLp: 0, feeValidator: 0, feeCommission: 0 });
const revert = (txid: string, at: number, standsAt?: string): Rec => ({ type: "revert", txid, tokenId: TOKEN, poolId: POOL, at, ...(standsAt ? { outpoint: `${standsAt}_0` } : {}) });
const px = (sats: bigint, tokens: bigint) => ({ sats, tokens });
const cq = (tf: string, from: number, to: number) => new URLSearchParams({ tf, from: String(from), to: String(to) });

/** A token's rows in a fresh `:memory:` store: `take` one event. */
function mk(tokenId = TOKEN) {
  const a = new Analytics(":memory:");
  return { a, take: (rec: Rec, place: string) => a.take(tokenId, rec, place) };
}
/** The minute starts holding priced swaps in [lo, hi). */
const keys = (a: Analytics, lo = 0, hi = Number.MAX_SAFE_INTEGER) => [...window(a, TOKEN, lo, hi)].map((m) => m.t);

test("two swaps in one minute: open / close by arrival order, not by at", () => {
  const f = mk();
  f.take(row("deploy", tx("a"), T0 - 120_000, 0), "1.0.t");
  // The first to arrive carries the LATER at within the minute.
  f.take(row("swap", tx("b"), T0 + 50_000, 1, buy(300, 10)), "2.0.t"); // 30 sats / token
  f.take(row("swap", tx("c"), T0 + 10_000, 2, sell(10, 100)), "3.0.t"); // 10 sats / token
  const [m] = candles(f.a, TOKEN, cq("1m", T0, T0 + 60_000));
  assert.deepEqual(m, { t: T0, o: px(300n, 10n), h: px(300n, 10n), l: px(100n, 10n), c: px(100n, 10n), volumeSats: 400n, volumeTokens: 20n, n: 2 });
  const tally = [...window(f.a, TOKEN, T0, T0 + 60_000)][0]!;
  assert.equal(tally.buys, 1);
  assert.equal(tally.sells, 1);
  assert.deepEqual(tally.trades.map((h) => h.txid), [tx("b"), tx("c")]);
});

test("a rollback of the minute's high: the minute worked out again; the only trade's minute removed; re-admitted as new", () => {
  const f = mk();
  f.take(row("deploy", tx("a"), T0 - 120_000, 0), "1.0.t");
  f.take(row("swap", tx("b"), T0 + 1_000, 1, buy(200, 10)), "2.0.t"); // 20
  f.take(row("swap", tx("c"), T0 + 2_000, 2, buy(500, 10)), "3.0.t"); // 50: the high
  f.take(row("swap", tx("d"), T0 + 3_000, 3, buy(300, 10)), "4.0.t"); // 30: the close
  f.take(row("swap", tx("e"), T0 + 60_000, 4, buy(400, 10)), "5.0.t"); // the next minute, alone
  assert.deepEqual(candles(f.a, TOKEN, cq("1m", T0, T0 + 120_000)).map((c) => [c.h, c.n]), [[px(500n, 10n), 3], [px(400n, 10n), 1]]);

  f.take(revert(tx("c"), T0 + 4_000, tx("b")), "6.0.t");
  const [m] = candles(f.a, TOKEN, cq("1m", T0, T0 + 60_000));
  assert.deepEqual(m, { t: T0, o: px(200n, 10n), h: px(300n, 10n), l: px(200n, 10n), c: px(300n, 10n), volumeSats: 500n, volumeTokens: 20n, n: 2 });

  f.take(revert(tx("e"), T0 + 61_000, tx("d")), "7.0.t");
  assert.deepEqual(candles(f.a, TOKEN, cq("1m", T0 + 60_000, T0 + 120_000)), []);
  assert.deepEqual(keys(f.a), [T0]);

  // Mined later after all: a new event with a new at, tallied as new in its own minute.
  f.take(row("swap", tx("e"), T0 + 185_000, 4, buy(400, 10)), "8.0.t");
  assert.deepEqual(keys(f.a), [T0, T0 + 180_000]);
  assert.equal(candles(f.a, TOKEN, cq("1m", T0, T0 + 240_000)).length, 2);
  assert.equal(instanceStats(f.a, TOKEN, T0).trades, 3);
});

test("a history-stamped trade arriving after a live one: its own older minute; /trades strictly event order", async () => {
  const f = mk();
  const LIVE = T0 + 7 * DAY_MS, OLD = T0;
  f.take(row("deploy", tx("a"), OLD - 60_000, 0), "1.0.t");
  f.take(row("swap", tx("b"), LIVE + 5_000, 1, buy(300, 10)), "2.0.t");
  const live = candles(f.a, TOKEN, cq("1m", LIVE, LIVE + 60_000));
  f.take(row("swap", tx("c"), OLD + 5_000, 2, buy(100, 10)), "3.0.t"); // older at, later event
  f.take(row("swap", tx("d"), OLD + 6_000, 3, buy(200, 10)), "4.0.t");
  assert.deepEqual(keys(f.a), [OLD, LIVE]);
  assert.deepEqual(candles(f.a, TOKEN, cq("1m", LIVE, LIVE + 60_000)), live);
  assert.deepEqual(candles(f.a, TOKEN, cq("1d", OLD - (OLD % DAY_MS), LIVE + 60_000)).map((c) => [c.t, c.n]), [[OLD - (OLD % DAY_MS), 2], [LIVE - (LIVE % DAY_MS), 1]]);

  const all = await trades(f.a, TOKEN, new URLSearchParams(), async () => null);
  assert.deepEqual(all.trades.map((r) => r.txid), [tx("d"), tx("c"), tx("b")]); // newest EVENT first
  assert.equal(all.next, null);
  const p1 = await trades(f.a, TOKEN, new URLSearchParams({ limit: "2" }), async () => null);
  assert.deepEqual(p1.trades.map((r) => r.txid), [tx("d"), tx("c")]);
  assert.equal(p1.next, "3.0.t");
  const p2 = await trades(f.a, TOKEN, new URLSearchParams({ limit: "2", before: p1.next! }), async () => null);
  assert.deepEqual(p2.trades.map((r) => r.txid), [tx("b")]);
  assert.equal(p2.next, null);
  // from / to filter each row's own at, the order stays event order.
  const old = await trades(f.a, TOKEN, new URLSearchParams({ from: String(OLD), to: String(OLD + 60_000) }), async () => null);
  assert.deepEqual(old.trades.map((r) => r.txid), [tx("d"), tx("c")]);
});

test("candles: minutes composed into tf buckets; the window's edge minutes filtered per trade; empty; the cap", () => {
  const f = mk();
  f.take(row("deploy", tx("a"), T0 - 60_000, 0), "1.0.t");
  f.take(row("swap", tx("b"), T0 + 10_000, 1, buy(100, 10)), "2.0.t");
  f.take(row("swap", tx("c"), T0 + 40_000, 2, buy(200, 10)), "3.0.t");
  f.take(row("swap", tx("d"), T0 + 70_000, 3, buy(600, 10)), "4.0.t");
  f.take(row("swap", tx("e"), T0 + 130_000, 4, buy(50, 10)), "5.0.t");
  // T0 is 240 s into its 5 m bucket and 2040 s into its hour: b, c in one 5 m bucket, d, e in the next; all four in one hour.
  const five = T0 - 240_000;
  assert.deepEqual(candles(f.a, TOKEN, cq("5m", five, five + 600_000)).map((c) => [c.t, c.n, c.o, c.c]),
    [[five, 2, px(100n, 10n), px(200n, 10n)], [five + 300_000, 2, px(600n, 10n), px(50n, 10n)]]);
  const hour = T0 - 2_040_000;
  assert.deepEqual(candles(f.a, TOKEN, cq("1h", hour, hour + 3_600_000)).map((c) => [c.t, c.o, c.h, c.l, c.c, c.volumeSats, c.n]),
    [[hour, px(100n, 10n), px(600n, 10n), px(50n, 10n), px(50n, 10n), 950n, 4]]);
  assert.equal(candles(f.a, TOKEN, cq("1d", hour, hour + 3_600_000)).length, 1);
  // Unaligned edges: from inside the first minute (after b), to inside the third (before e at +130 s).
  const cut = candles(f.a, TOKEN, cq("1m", T0 + 20_000, T0 + 125_000));
  assert.deepEqual(cut.map((c) => [c.t, c.n, c.o]), [[T0, 1, px(200n, 10n)], [T0 + 60_000, 1, px(600n, 10n)]]);
  assert.deepEqual(candles(f.a, TOKEN, cq("1m", T0 + 11_000, T0 + 39_000)), []);
  assert.equal(minuteOf(T0 + 59_999), T0);
  assert.throws(() => candles(f.a, TOKEN, cq("1m", 0, T0)), BadQuery);
});

test("/stats: 24 h from the tallies with exact edges; the last swap event; a rollback; the lifetime counters", () => {
  const f = mk();
  const now = T0 + 30_000;
  f.take(row("deploy", tx("a"), now - 2 * DAY_MS, 0), "1.0.t");
  f.take(row("swap", tx("b"), now - DAY_MS, 1, buy(100, 10)), "2.0.t"); // at now − 24 h: excluded
  f.take(row("swap", tx("c"), now - DAY_MS + 1, 2, buy(200, 10)), "3.0.t"); // included
  f.take(row("swap", tx("d"), now, 3, sell(10, 300)), "4.0.t"); // at now: included
  f.take(row("swap", tx("e"), now + 1, 4, buy(400, 10)), "5.0.t"); // the future: excluded
  f.take(row("swap", tx("f"), now - 5_000, 5, buy(500, 0)), "6.0.t"); // no tokens: counts in `trades` only
  f.take(row("swap", tx("g"), now - 3 * DAY_MS, 6, buy(700, 10)), "7.0.t"); // the last EVENT, an older at
  let s = instanceStats(f.a, TOKEN, now);
  assert.deepEqual([s.volume24hSats, s.volume24hTokens, s.buys24h, s.sells24h], [500n, 20n, 1, 1]);
  assert.deepEqual([s.lastTradePrice, s.lastTradeAt], [px(700n, 10n), now - 3 * DAY_MS]);
  assert.deepEqual([s.volumeSats, s.volumeTokens, s.trades], [1700n, 50n, 6]);

  // Roll back the last trade (→ the previous swap event, the priceless one) and one inside the window.
  f.take(revert(tx("g"), now, tx("f")), "8.0.t");
  f.take(revert(tx("d"), now, tx("c")), "9.0.t");
  s = instanceStats(f.a, TOKEN, now);
  assert.deepEqual([s.volume24hSats, s.volume24hTokens, s.buys24h, s.sells24h], [200n, 10n, 1, 0]);
  assert.deepEqual([s.lastTradePrice, s.lastTradeAt], [null, now - 5_000]);
  assert.deepEqual([s.volumeSats, s.volumeTokens, s.trades], [700n, 30n, 4]);
});

test("/pools/at: a later event with an earlier at stops at the first at > t; /pools/history on each row's own at", () => {
  const f = mk();
  f.take(row("deploy", tx("a"), 1000, 0), "1.0.t");
  f.take(row("swap", tx("b"), 3000, 1, buy(100, 10)), "2.0.t"); // step-stamped (or a block with a late header)
  f.take(row("swap", tx("c"), 2000, 2, buy(100, 10)), "3.0.t"); // its child, block-stamped earlier
  const at = (t: number) => poolsAt(f.a, TOKEN, t).map((r) => r.swaps);
  assert.deepEqual(at(999), []);
  assert.deepEqual(at(1000), [0]);
  // c's own at (2000) is ≤ 2500, but b before it in the pool's events is not: the walk stops at b.
  assert.deepEqual(at(2500), [0]);
  assert.deepEqual(at(2999), [0]);
  assert.deepEqual(at(3000), [2]);

  const hist = (q: Rec) => poolHistory(f.a, TOKEN, new URLSearchParams(q as Record<string, string>));
  assert.deepEqual(hist({}).events.map((r) => r.txid), [tx("a"), tx("b"), tx("c")]);
  assert.deepEqual(hist({ pool: POOL, to: "3000" }).events.map((r) => r.txid), [tx("a"), tx("c")]);
  assert.deepEqual(hist({ pool: POOL, from: "2500" }).events.map((r) => r.txid), [tx("b")]);
  const p1 = hist({ limit: "2" });
  assert.deepEqual(p1.events.map((r) => r.txid), [tx("a"), tx("b")]);
  assert.equal(p1.next, "2.0.t");
  const p2 = hist({ limit: "2", after: p1.next! });
  assert.deepEqual(p2.events.map((r) => r.txid), [tx("c")]);
  assert.equal(p2.next, null);
});

test("an old-format /trades cursor is refused 400; series=market is an unknown series (400)", async () => {
  const f = mk();
  f.take(row("deploy", tx("a"), T0, 0), "1.0.t");
  f.take(row("swap", tx("b"), T0 + 1, 1, buy(100, 10)), "2.0.t");
  const hex = (s: string) => Buffer.from(s).toString("hex");
  for (const before of [hex(`${T0}:2.0.t`), hex(`${T0}:${tx("b")}`), "zz"]) {
    await assert.rejects(trades(f.a, TOKEN, new URLSearchParams({ before }), async () => null), BadQuery);
  }
  const pools = new Pools({} as Router, () => {}, () => null, f.a);
  const a = await pools.appRead(TOKEN, "/amm/candles", new URL(`http://x/@${TOKEN}/amm/candles?series=market&tf=1m&from=0&to=60000`), {} as never);
  assert.equal(a?.status, 400);
  assert.match(new TextDecoder().decode(a!.body), /ERR_BAD_REQUEST/);
});

// ---------------------------------------------------------------- the store across a restart (2026-11-12)

const THREAD = "bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const at = (s: number) => `${s}.0.${THREAD}`;
const ev = (s: number, rec: Rec) => ({ id: at(s), event: "amm/hop", data: JSON.stringify(rec) });

/** A router whose instance index is `index` (subscribe honours `after`); `asked` the queries, `sent` the events handed over, `live` the last stream. */
function fakeRouter(index: Array<{ id: string; event: string; data: string }>) {
  const o = { asked: [] as Array<{ after?: { s: number; i: number } }>, sent: 0, live: undefined as undefined | ((d: { id: string; event: string; data: string }) => void) };
  const router = { events: {
    subscribe: async (_h: string, q: { after?: { s: number; i: number } }, send: (d: { id: string; event: string; data: string }) => void) => {
      o.asked.push(q);
      for (const d of index) {
        const [s, i] = d.id.split(".").map(Number) as [number, number];
        if (!q.after || s > q.after.s || (s === q.after.s && i > q.after.i)) { o.sent++; send(d); }
      }
      o.live = send;
      return () => {};
    },
    read: async () => [],
  } } as unknown as Router;
  return { router, o };
}

test("a restart resumes after the stored place: earlier events not read again, no row twice; a revert removes its rows; live hops to the feed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ox-analytics-"));
  const file = join(dir, "analytics.sqlite");
  try {
    const index = [
      ev(1, row("deploy", tx("a"), T0, 0)),
      ev(2, row("swap", tx("b"), T0 + 1_000, 1, buy(100, 10))),
      ev(3, row("swap", tx("c"), T0 + 2_000, 2, buy(200, 10))),
    ];
    const one = fakeRouter(index);
    let a = new Analytics(file);
    await new Folds(one.router, () => {}, a).ensure(TOKEN);
    assert.equal(one.o.asked[0]!.after, undefined); // nothing stored: from place zero
    assert.equal(a.head(TOKEN), at(3));
    assert.equal(a.hops(TOKEN).length, 3);
    a.close();

    // While stopped: one more swap, and a revert of b (the pool stands at c).
    index.push(ev(4, row("swap", tx("d"), T0 + 3_000, 3, buy(300, 10))), ev(5, revert(tx("b"), T0 + 4_000, tx("c"))));
    const two = fakeRouter(index);
    a = new Analytics(file);
    const folds = new Folds(two.router, () => {}, a);
    const fed: Hop[] = [];
    folds.onHop = (_t, h) => fed.push(h);
    await folds.ensure(TOKEN);
    assert.deepEqual([two.o.asked[0]!.after?.s, two.o.asked[0]!.after?.i], [3, 0]);
    assert.equal(two.o.sent, 2); // only the two events after the stored place
    assert.equal(fed.length, 0); // the catch-up is not news
    assert.deepEqual(a.hops(TOKEN).map((h) => h.txid), [tx("a"), tx("c"), tx("d")]);
    assert.equal(a.head(TOKEN), at(5));
    assert.deepEqual(a.poolsNow(TOKEN).map((h) => [h.kind, h.outpoint]), [["revert", `${tx("c")}_0`]]);
    assert.equal(a.standing(TOKEN, tx("b")), false);
    assert.equal(instanceStats(a, TOKEN, T0 + 5_000).trades, 2);

    // Live: into the store and to the feed.
    two.o.live!(ev(6, row("swap", tx("e"), T0 + 5_000, 4, sell(10, 50))));
    assert.deepEqual(fed.map((h) => h.txid), [tx("e")]);
    assert.equal(a.head(TOKEN), at(6));
    assert.equal(a.hops(TOKEN).length, 4);
    a.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a revert with no outpoint: its rows gone, the pool gone from the listing", () => {
  const f = mk();
  f.take(row("deploy", tx("a"), T0, 0), "1.0.t");
  assert.equal(f.a.livePools(TOKEN).length, 1);
  f.take(revert(tx("a"), T0 + 1), "2.0.t");
  assert.deepEqual([f.a.hops(TOKEN).length, f.a.livePools(TOKEN).length, f.a.poolsNow(TOKEN).length], [0, 0, 0]);
});

// ---------------------------------------------------------------- GET <origin>/amm/lp/fees (2026-11-12)

test("/amm/lp/fees: buy in sats, sell in tokens; the period from ≤ at < to; pools across two tokens; byPool; the empty shape; 400s", async () => {
  const TOKEN2 = `${"dd".repeat(32)}_1`;
  const PA = POOL, PB = `${"bb".repeat(32)}_0`, PC = `${"cc".repeat(32)}_1`, PX = `${"99".repeat(32)}_0`;
  const a = new Analytics(":memory:");
  const fee = (x: Rec, feeLp: number | bigint) => ({ ...x, feeLp });
  a.take(TOKEN, row("deploy", tx("1"), T0, 0), "1.0.t");
  a.take(TOKEN, row("swap", tx("2"), T0 + 1_000, 1, fee(buy(1000, 10), 3)), "2.0.t"); // PA buy: 3 sats
  a.take(TOKEN, row("swap", tx("3"), T0 + 2_000, 2, fee(sell(10, 1000), 7)), "3.0.t"); // PA sell: 7 tokens
  a.take(TOKEN, row("swap", tx("4"), T0 + 3_000, 1, { ...fee(buy(500, 5), 2), poolId: PB }), "4.0.t"); // PB buy: 2 sats
  const big = 2n ** 60n + 1n;
  a.take(TOKEN2, row("swap", tx("5"), T0 + 4_000, 1, { ...fee(sell(10, 100), big), tokenId: TOKEN2, poolId: PC }), "1.0.t"); // PC sell: 2^60 + 1 tokens
  a.take(TOKEN2, row("swap", tx("6"), T0 + 5_000, 2, { ...fee(buy(100, 10), 11), tokenId: TOKEN2, poolId: PC }), "2.0.t"); // PC buy, at = to below
  const pools = new Pools({} as Router, () => {}, () => null, a);
  const read = async (qs: string) => {
    const r = (await pools.appRead(SWAP, "/amm/lp/fees", new URL(`http://x/amm/lp/fees?${qs}`), {} as never))!;
    return { status: r.status, body: JSON.parse(new TextDecoder().decode(r.body)) as Rec };
  };

  const all = await read(`pool=${PA},${PB},${PC},${PX}`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body, {
    from: null, to: null, sats: "16",
    tokens: [{ tokenId: TOKEN, amount: "7" }, { tokenId: TOKEN2, amount: (big).toString() }],
    swaps: 5, pools: 3,
    byPool: [
      { poolId: PA, tokenId: TOKEN, sats: "3", tokens: "7", swaps: 2 },
      { poolId: PB, tokenId: TOKEN, sats: "2", tokens: "0", swaps: 1 },
      { poolId: PC, tokenId: TOKEN2, sats: "11", tokens: big.toString(), swaps: 2 },
    ],
  });
  // from inclusive (PA's buy at T0 + 1000 in), to exclusive (PC's buy at T0 + 5000 out).
  const win = await read(`pool=${PA},${PC}&from=${T0 + 1_000}&to=${T0 + 5_000}`);
  assert.deepEqual([win.body.from, win.body.to, win.body.sats, win.body.swaps, win.body.pools], [T0 + 1_000, T0 + 5_000, "3", 3, 2]);
  assert.deepEqual(win.body.tokens, [{ tokenId: TOKEN, amount: "7" }, { tokenId: TOKEN2, amount: big.toString() }]);
  const late = await read(`pool=${PA}&from=${T0 + 1_001}`);
  assert.deepEqual([late.body.sats, late.body.tokens, late.body.swaps], ["0", [{ tokenId: TOKEN, amount: "7" }], 1]);
  // None in the period: the empty shape.
  assert.deepEqual((await read(`pool=${PX}&from=0&to=1`)).body, { from: 0, to: 1, sats: "0", tokens: [], swaps: 0, pools: 0, byPool: [] });
  // Bad queries.
  for (const qs of ["", "pool=", "pool=abc", `pool=${PA},${tx("a")}.0`, `pool=${PA}&from=x`, `pool=${PA}&to=1.5`]) {
    const r = await read(qs);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.code, "ERR_BAD_REQUEST");
  }
});
