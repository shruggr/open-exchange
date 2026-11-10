// One pool hop as the host's folds read it (0.21.0). The AMM recognizer (skein-amm, branch `recognizers`) emits a hop
// per admitted deploy / swap / close / rescind, and a revert when a hop's transaction is later rejected, under
// `amm/hop` (every hop, log order) and `amm/pool/<poolId>`. THIS FILE IS THE ONE PLACE the recognizer's record field
// names are read: when its report lands, the names are fixed here and nowhere else.
//
// The recognizer's row (skein-amm 0.49.0, release-0.49 bfdab2e): `type` deploy|swap|close|rescind (was `kind`: the
// kernel reserves `kind` and `app` on an emitted record), `txid`,
// `tokenId`, `poolId`, `outpoint?`, `bsvReserve?`, `tokenReserve?`, `lpPubKey`, `liquidityFeeBps`, `validationFeeBps`,
// `commissionBps`, `validatorIdentityKey`, `at` (ms), `swaps`, `keyId?`; a swap adds `side`, `amountIn`, `amountOut`,
// `feeLp`, `feeValidator`, `feeCommission`, `commissionPkh`, `payoutPkh`, `feeVouts {lp?, validator?, commission?}`.
// A REVERT is `{type: "revert", txid: <the unwound tx>, tokenId, poolId, at}` plus the pool's fields as it stands after
// the undo (none when the pool is gone). Rows are also under `amm/pool/<txid>_<vout>` and `amm/output/<txid>.<vout>`.
import type { Rec } from "../events.ts";

/** The event name the folds follow: every hop of the token instance, in log order. */
export const HOP_EVENT = "amm/hop";

export type Kind = "deploy" | "swap" | "close" | "rescind" | "revert";

/** A price: `sats` per `tokens` (base units), exact. */
export interface Price { sats: bigint; tokens: bigint }

export interface Hop {
  kind: Kind;
  txid: string;
  poolId: string;
  /** The pool output after the hop (none for a close, or a revert that left no pool). */
  outpoint?: string;
  bsvReserve: bigint;
  tokenReserve: bigint;
  lpPubKey: string | null;
  liquidityFeeBps: number;
  validationFeeBps: number;
  commissionBps: number;
  validatorIdentityKey: string;
  at: number;
  swaps: number;
  /** A swap's trade. */
  side?: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  feeLp: bigint;
  feeValidator: bigint;
  feeCommission: bigint;
  commissionPkh?: string;
  payoutPkh?: string;
  /** The row's place in the instance's event index (`<n>.<seq>.<i>.<thread>`): `/pools/history`'s order and cursor. */
  place: string;
  /** The record as the recognizer emitted it (what the pool feeds and `/pools/history` hand out). */
  row: Rec;
}

const big = (x: unknown): bigint => typeof x === "bigint" ? x : typeof x === "number" && Number.isFinite(x) ? BigInt(Math.trunc(x)) : typeof x === "string" && /^\d+$/.test(x) ? BigInt(x) : 0n;
const num = (x: unknown): number => typeof x === "number" ? x : typeof x === "bigint" ? Number(x) : 0;
const text = (x: unknown): string | undefined => typeof x === "string" ? x : undefined;
const KINDS = new Set<Kind>(["deploy", "swap", "close", "rescind", "revert"]);

/** A hop from its record, or undefined when the record is not one. */
export function hopOf(rec: Rec, place = ""): Hop | undefined {
  const kind = text(rec.type) as Kind | undefined;
  const txid = text(rec.txid), poolId = text(rec.poolId);
  if (!kind || !KINDS.has(kind) || !txid || !poolId) return undefined;
  const side = rec.side === "buy" || rec.side === "sell" ? rec.side : undefined;
  const row: Rec = { ...rec };
  delete row.event; delete row.app; // the emit's own fields, not the row's
  return {
    kind, txid, poolId,
    ...(text(rec.outpoint) ? { outpoint: text(rec.outpoint)! } : {}),
    bsvReserve: big(rec.bsvReserve), tokenReserve: big(rec.tokenReserve),
    lpPubKey: text(rec.lpPubKey) ?? null,
    liquidityFeeBps: num(rec.liquidityFeeBps), validationFeeBps: num(rec.validationFeeBps), commissionBps: num(rec.commissionBps),
    validatorIdentityKey: text(rec.validatorIdentityKey) ?? "",
    at: num(rec.at), swaps: num(rec.swaps),
    ...(side ? { side } : {}),
    amountIn: big(rec.amountIn), amountOut: big(rec.amountOut),
    feeLp: big(rec.feeLp), feeValidator: big(rec.feeValidator), feeCommission: big(rec.feeCommission),
    ...(text(rec.commissionPkh) ? { commissionPkh: text(rec.commissionPkh)! } : {}),
    ...(text(rec.payoutPkh) ? { payoutPkh: text(rec.payoutPkh)! } : {}),
    place, row,
  };
}

/** Index places in log order: (n, seq, i) numerically, then the thread (the index's own tie order is the thread's bytes). */
export function placeCmp(x: string, y: string): number {
  const a = x.split("."), b = y.split(".");
  for (let k = 0; k < 3; k++) { const d = Number(a[k]) - Number(b[k]); if (d) return d; }
  return (a[3] ?? "") < (b[3] ?? "") ? -1 : (a[3] ?? "") > (b[3] ?? "") ? 1 : 0;
}

/** A swap's price from its amounts by side (a buy paid amountIn sats for amountOut tokens); undefined with no tokens. */
export function priceOf(h: Hop): Price | undefined {
  if (h.kind !== "swap" || !h.side) return undefined;
  const p = h.side === "buy" ? { sats: h.amountIn, tokens: h.amountOut } : { sats: h.amountOut, tokens: h.amountIn };
  return p.tokens === 0n ? undefined : p;
}

/** x < y by cross multiplication. */
export const priceLt = (x: Price, y: Price): boolean => x.sats * y.tokens < y.sats * x.tokens;

/** The pool fields a `/pools/at` row and a pools row carry (amm-lookup `poolRowFields`), from a hop. */
export function poolFields(h: Hop): Rec {
  return {
    poolId: h.poolId,
    ...(h.outpoint ? { outpoint: h.outpoint, bsvReserve: h.bsvReserve, tokenReserve: h.tokenReserve } : {}),
    lpPubKey: h.lpPubKey,
    liquidityFeeBps: h.liquidityFeeBps, validationFeeBps: h.validationFeeBps, commissionBps: h.commissionBps,
    validatorIdentityKey: h.validatorIdentityKey, at: h.at, swaps: h.swaps,
  };
}
