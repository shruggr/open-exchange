// The folds (0.25.0, David 2026-11-11): the hops stay in EVENT order, nothing re-sorts them; the candles come from the
// per-minute tallies kept as each swap arrives (open / close within a minute by arrival, a rollback works its minute
// out again); /trades newest first in event order with a place cursor; /stats' 24 h from the tallies; /pools/at walks a
// pool's events in order and stops at the first with `at > t`; /pools/history filters each row on its own `at`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenFold } from "./fold.ts";
import { BadQuery, trades } from "./trades.ts";
import { candles, minuteOf } from "./candles.ts";
import { instanceStats, DAY_MS } from "./stats.ts";
import { poolsAt } from "./pools-at.ts";
import { poolHistory } from "./pool-history.ts";
import { Pools } from "../pools.ts";
import type { Router } from "../skein.ts";
import type { Rec } from "../events.ts";

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

test("two swaps in one minute: open / close by arrival order, not by at", () => {
  const f = new TokenFold(TOKEN);
  f.take(row("deploy", tx("a"), T0 - 120_000, 0), "1.0.t");
  // The first to arrive carries the LATER at within the minute.
  f.take(row("swap", tx("b"), T0 + 50_000, 1, buy(300, 10)), "2.0.t"); // 30 sats / token
  f.take(row("swap", tx("c"), T0 + 10_000, 2, sell(10, 100)), "3.0.t"); // 10 sats / token
  const [m] = candles(f, cq("1m", T0, T0 + 60_000));
  assert.deepEqual(m, { t: T0, o: px(300n, 10n), h: px(300n, 10n), l: px(100n, 10n), c: px(100n, 10n), volumeSats: 400n, volumeTokens: 20n, n: 2 });
  const tally = f.tally.minutes.get(T0)!;
  assert.equal(tally.buys, 1);
  assert.equal(tally.sells, 1);
  assert.deepEqual(tally.trades.map((h) => h.txid), [tx("b"), tx("c")]);
});

test("a rollback of the minute's high: the minute worked out again; the only trade's minute removed; re-admitted as new", () => {
  const f = new TokenFold(TOKEN);
  f.take(row("deploy", tx("a"), T0 - 120_000, 0), "1.0.t");
  f.take(row("swap", tx("b"), T0 + 1_000, 1, buy(200, 10)), "2.0.t"); // 20
  f.take(row("swap", tx("c"), T0 + 2_000, 2, buy(500, 10)), "3.0.t"); // 50: the high
  f.take(row("swap", tx("d"), T0 + 3_000, 3, buy(300, 10)), "4.0.t"); // 30: the close
  f.take(row("swap", tx("e"), T0 + 60_000, 4, buy(400, 10)), "5.0.t"); // the next minute, alone
  assert.deepEqual(candles(f, cq("1m", T0, T0 + 120_000)).map((c) => [c.h, c.n]), [[px(500n, 10n), 3], [px(400n, 10n), 1]]);

  f.take(revert(tx("c"), T0 + 4_000, tx("b")), "6.0.t");
  const [m] = candles(f, cq("1m", T0, T0 + 60_000));
  assert.deepEqual(m, { t: T0, o: px(200n, 10n), h: px(300n, 10n), l: px(200n, 10n), c: px(300n, 10n), volumeSats: 500n, volumeTokens: 20n, n: 2 });

  f.take(revert(tx("e"), T0 + 61_000, tx("d")), "7.0.t");
  assert.equal(f.tally.minutes.has(T0 + 60_000), false);
  assert.deepEqual(f.tally.keys, [T0]);

  // Mined later after all: a new event with a new at, tallied as new in its own minute.
  f.take(row("swap", tx("e"), T0 + 185_000, 4, buy(400, 10)), "8.0.t");
  assert.deepEqual(f.tally.keys, [T0, T0 + 180_000]);
  assert.equal(candles(f, cq("1m", T0, T0 + 240_000)).length, 2);
  assert.equal(f.trades, 3);
});

test("a history-stamped trade arriving after a live one: its own older minute; /trades strictly event order", async () => {
  const f = new TokenFold(TOKEN);
  const LIVE = T0 + 7 * DAY_MS, OLD = T0;
  f.take(row("deploy", tx("a"), OLD - 60_000, 0), "1.0.t");
  f.take(row("swap", tx("b"), LIVE + 5_000, 1, buy(300, 10)), "2.0.t");
  const live = candles(f, cq("1m", LIVE, LIVE + 60_000));
  f.take(row("swap", tx("c"), OLD + 5_000, 2, buy(100, 10)), "3.0.t"); // older at, later event
  f.take(row("swap", tx("d"), OLD + 6_000, 3, buy(200, 10)), "4.0.t");
  assert.deepEqual(f.tally.keys, [OLD, LIVE]);
  assert.deepEqual(candles(f, cq("1m", LIVE, LIVE + 60_000)), live);
  assert.deepEqual(candles(f, cq("1d", OLD - (OLD % DAY_MS), LIVE + 60_000)).map((c) => [c.t, c.n]), [[OLD - (OLD % DAY_MS), 2], [LIVE - (LIVE % DAY_MS), 1]]);

  const all = await trades(f, new URLSearchParams(), async () => null);
  assert.deepEqual(all.trades.map((r) => r.txid), [tx("d"), tx("c"), tx("b")]); // newest EVENT first
  assert.equal(all.next, null);
  const p1 = await trades(f, new URLSearchParams({ limit: "2" }), async () => null);
  assert.deepEqual(p1.trades.map((r) => r.txid), [tx("d"), tx("c")]);
  assert.equal(p1.next, "3.0.t");
  const p2 = await trades(f, new URLSearchParams({ limit: "2", before: p1.next! }), async () => null);
  assert.deepEqual(p2.trades.map((r) => r.txid), [tx("b")]);
  assert.equal(p2.next, null);
  // from / to filter each row's own at, the order stays event order.
  const old = await trades(f, new URLSearchParams({ from: String(OLD), to: String(OLD + 60_000) }), async () => null);
  assert.deepEqual(old.trades.map((r) => r.txid), [tx("d"), tx("c")]);
});

test("candles: minutes composed into tf buckets; the window's edge minutes filtered per trade; empty; the cap", () => {
  const f = new TokenFold(TOKEN);
  f.take(row("deploy", tx("a"), T0 - 60_000, 0), "1.0.t");
  f.take(row("swap", tx("b"), T0 + 10_000, 1, buy(100, 10)), "2.0.t");
  f.take(row("swap", tx("c"), T0 + 40_000, 2, buy(200, 10)), "3.0.t");
  f.take(row("swap", tx("d"), T0 + 70_000, 3, buy(600, 10)), "4.0.t");
  f.take(row("swap", tx("e"), T0 + 130_000, 4, buy(50, 10)), "5.0.t");
  // T0 is 240 s into its 5 m bucket and 2040 s into its hour: b, c in one 5 m bucket, d, e in the next; all four in one hour.
  const five = T0 - 240_000;
  assert.deepEqual(candles(f, cq("5m", five, five + 600_000)).map((c) => [c.t, c.n, c.o, c.c]),
    [[five, 2, px(100n, 10n), px(200n, 10n)], [five + 300_000, 2, px(600n, 10n), px(50n, 10n)]]);
  const hour = T0 - 2_040_000;
  assert.deepEqual(candles(f, cq("1h", hour, hour + 3_600_000)).map((c) => [c.t, c.o, c.h, c.l, c.c, c.volumeSats, c.n]),
    [[hour, px(100n, 10n), px(600n, 10n), px(50n, 10n), px(50n, 10n), 950n, 4]]);
  assert.equal(candles(f, cq("1d", hour, hour + 3_600_000)).length, 1);
  // Unaligned edges: from inside the first minute (after b), to inside the third (before e at +130 s).
  const cut = candles(f, cq("1m", T0 + 20_000, T0 + 125_000));
  assert.deepEqual(cut.map((c) => [c.t, c.n, c.o]), [[T0, 1, px(200n, 10n)], [T0 + 60_000, 1, px(600n, 10n)]]);
  assert.deepEqual(candles(f, cq("1m", T0 + 11_000, T0 + 39_000)), []);
  assert.equal(minuteOf(T0 + 59_999), T0);
  assert.throws(() => candles(f, cq("1m", 0, T0)), BadQuery);
});

test("/stats: 24 h from the tallies with exact edges; the last swap event; a rollback; the lifetime counters", () => {
  const f = new TokenFold(TOKEN);
  const now = T0 + 30_000;
  f.take(row("deploy", tx("a"), now - 2 * DAY_MS, 0), "1.0.t");
  f.take(row("swap", tx("b"), now - DAY_MS, 1, buy(100, 10)), "2.0.t"); // at now − 24 h: excluded
  f.take(row("swap", tx("c"), now - DAY_MS + 1, 2, buy(200, 10)), "3.0.t"); // included
  f.take(row("swap", tx("d"), now, 3, sell(10, 300)), "4.0.t"); // at now: included
  f.take(row("swap", tx("e"), now + 1, 4, buy(400, 10)), "5.0.t"); // the future: excluded
  f.take(row("swap", tx("f"), now - 5_000, 5, buy(500, 0)), "6.0.t"); // no tokens: counts in `trades` only
  f.take(row("swap", tx("g"), now - 3 * DAY_MS, 6, buy(700, 10)), "7.0.t"); // the last EVENT, an older at
  let s = instanceStats(f, now);
  assert.deepEqual([s.volume24hSats, s.volume24hTokens, s.buys24h, s.sells24h], [500n, 20n, 1, 1]);
  assert.deepEqual([s.lastTradePrice, s.lastTradeAt], [px(700n, 10n), now - 3 * DAY_MS]);
  assert.deepEqual([s.volumeSats, s.volumeTokens, s.trades], [1700n, 50n, 6]);

  // Roll back the last trade (→ the previous swap event, the priceless one) and one inside the window.
  f.take(revert(tx("g"), now, tx("f")), "8.0.t");
  f.take(revert(tx("d"), now, tx("c")), "9.0.t");
  s = instanceStats(f, now);
  assert.deepEqual([s.volume24hSats, s.volume24hTokens, s.buys24h, s.sells24h], [200n, 10n, 1, 0]);
  assert.deepEqual([s.lastTradePrice, s.lastTradeAt], [null, now - 5_000]);
  assert.deepEqual([s.volumeSats, s.volumeTokens, s.trades], [700n, 30n, 4]);
});

test("/pools/at: a later event with an earlier at stops at the first at > t; /pools/history on each row's own at", () => {
  const f = new TokenFold(TOKEN);
  f.take(row("deploy", tx("a"), 1000, 0), "1.0.t");
  f.take(row("swap", tx("b"), 3000, 1, buy(100, 10)), "2.0.t"); // step-stamped (or a block with a late header)
  f.take(row("swap", tx("c"), 2000, 2, buy(100, 10)), "3.0.t"); // its child, block-stamped earlier
  const at = (t: number) => poolsAt(f, t).map((r) => r.swaps);
  assert.deepEqual(at(999), []);
  assert.deepEqual(at(1000), [0]);
  // c's own at (2000) is ≤ 2500, but b before it in the pool's events is not: the walk stops at b.
  assert.deepEqual(at(2500), [0]);
  assert.deepEqual(at(2999), [0]);
  assert.deepEqual(at(3000), [2]);

  const hist = (q: Rec) => poolHistory(f, new URLSearchParams(q as Record<string, string>));
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
  const f = new TokenFold(TOKEN);
  f.take(row("deploy", tx("a"), T0, 0), "1.0.t");
  f.take(row("swap", tx("b"), T0 + 1, 1, buy(100, 10)), "2.0.t");
  const hex = (s: string) => Buffer.from(s).toString("hex");
  for (const before of [hex(`${T0}:2.0.t`), hex(`${T0}:${tx("b")}`), "zz"]) {
    await assert.rejects(trades(f, new URLSearchParams({ before }), async () => null), BadQuery);
  }
  const pools = new Pools({} as Router, () => {}, () => null);
  const a = await pools.appRead(TOKEN, "/amm/candles", new URL(`http://x/@${TOKEN}/amm/candles?series=market&tf=1m&from=0&to=60000`), {} as never);
  assert.equal(a?.status, 400);
  assert.match(new TextDecoder().decode(a!.body), /ERR_BAD_REQUEST/);
});
