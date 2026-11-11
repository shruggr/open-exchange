// The folds' order (0.24.0, skein-amm 0.52.0: a hop recorded mined carries its block's time, so `at` ties within a
// block and is not monotonic along a pool's history): `swaps()` breaks an `at` tie by event place, `poolHops()` is
// place order, and `/pools/at` and `/pools/history` judge a hop by its effective time (the greatest `at` up to it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenFold } from "./fold.ts";
import { trades } from "./trades.ts";
import { candles } from "./candles.ts";
import { poolsAt } from "./pools-at.ts";
import { poolHistory } from "./pool-history.ts";
import type { Rec } from "../events.ts";

const TOKEN = `${"ee".repeat(32)}_0`;
const POOL = `${"aa".repeat(32)}_0`;
const tx = (c: string) => c.repeat(64);

/** A hop row as the recognizer emits it (the fields the folds read). */
function row(type: string, txid: string, at: number, swaps: number, x: Rec = {}): Rec {
  return {
    type, txid, tokenId: TOKEN, poolId: POOL, outpoint: `${txid}_0`, bsvReserve: 1000 + swaps, tokenReserve: 5000 - swaps,
    lpPubKey: "02" + "11".repeat(32), liquidityFeeBps: 30, validationFeeBps: 0, commissionBps: 0, validatorIdentityKey: "02" + "22".repeat(32),
    at, swaps, ...x,
  };
}
const buy = (sats: number, tokens: number): Rec => ({ side: "buy", amountIn: sats, amountOut: tokens, feeLp: 0, feeValidator: 0, feeCommission: 0 });

test("two swaps of one pool in one block: history order in /trades and the candle's open / close", async () => {
  const f = new TokenFold(TOKEN);
  const BLOCK = 1_793_000_040_000;
  f.take(row("deploy", tx("a"), 1_793_000_000_000, 0), "1.0.t");
  // The chained swaps share the block's time; the later one's txid sorts FIRST (by txid the order would flip).
  f.take(row("swap", tx("f"), BLOCK, 1, buy(100, 10)), "2.0.t"); // price 10 sats / token
  f.take(row("swap", tx("1"), BLOCK, 2, buy(300, 10)), "3.0.t"); // price 30 sats / token
  assert.deepEqual(f.swaps().map((h) => h.txid), [tx("f"), tx("1")]);

  const page = await trades(f, new URLSearchParams(), async () => 100);
  assert.deepEqual(page.trades.map((r) => r.txid), [tx("1"), tx("f")]); // newest first

  // Paging across the tie: a page of one, then the rest from its cursor.
  const p1 = await trades(f, new URLSearchParams({ limit: "1" }), async () => null);
  assert.deepEqual(p1.trades.map((r) => r.txid), [tx("1")]);
  const p2 = await trades(f, new URLSearchParams({ limit: "1", before: p1.next! }), async () => null);
  assert.deepEqual(p2.trades.map((r) => r.txid), [tx("f")]);
  const p3 = await trades(f, new URLSearchParams({ limit: "1", before: p2.next! }), async () => null);
  assert.deepEqual(p3.trades, []);

  const c = candles(f, new URLSearchParams({ tf: "1m", from: String(BLOCK - 60_000), to: String(BLOCK + 60_000) }));
  assert.equal(c.length, 1);
  assert.deepEqual(c[0]!.o, { sats: 100n, tokens: 10n });
  assert.deepEqual(c[0]!.c, { sats: 300n, tokens: 10n });
  assert.equal(c[0]!.n, 2);
});

test("a later hop with a smaller at: /pools/at and /pools/history stand on the pool's history prefix", () => {
  const f = new TokenFold(TOKEN);
  f.take(row("deploy", tx("a"), 1000, 0), "1.0.t");
  f.take(row("swap", tx("b"), 3000, 1, buy(100, 10)), "2.0.t"); // step-stamped (or a block with a late header)
  f.take(row("swap", tx("c"), 2000, 2, buy(100, 10)), "3.0.t"); // its child, block-stamped earlier
  assert.deepEqual(f.poolHops(POOL).map((h) => h.txid), [tx("a"), tx("b"), tx("c")]);

  const at = (t: number) => poolsAt(f, t).map((r) => r.swaps);
  assert.deepEqual(at(999), []);
  assert.deepEqual(at(1000), [0]);
  // c's own at (2000) is ≤ 2500, but b (its parent) had not happened by then: the deploy's state, not c's.
  assert.deepEqual(at(2500), [0]);
  assert.deepEqual(at(2999), [0]);
  assert.deepEqual(at(3000), [2]);

  const hist = (q: Rec) => poolHistory(f, new URLSearchParams(q as Record<string, string>));
  assert.deepEqual(hist({}).events.map((r) => r.txid), [tx("a"), tx("b"), tx("c")]);
  assert.deepEqual(hist({ pool: POOL, to: "3000" }).events.map((r) => r.txid), [tx("a")]);
  assert.deepEqual(hist({ pool: POOL, from: "2500" }).events.map((r) => r.txid), [tx("b"), tx("c")]);
  assert.deepEqual(hist({ from: "3000", to: "3001" }).events.map((r) => r.txid), [tx("b"), tx("c")]);
  // The rows are the records as emitted (c keeps its own at).
  assert.equal(hist({ from: "3000" }).events[1]!.at, 2000);
  // Paging in place order.
  const p1 = hist({ limit: "2" });
  assert.deepEqual(p1.events.map((r) => r.txid), [tx("a"), tx("b")]);
  assert.equal(p1.next, "2.0.t");
  const p2 = hist({ limit: "2", after: p1.next! });
  assert.deepEqual(p2.events.map((r) => r.txid), [tx("c")]);
  assert.equal(p2.next, null);
});
