// The lifetime counters (amm-lookup 0.47.0 `PoolCounters`, `TokenCounters`), summed from the fold's swaps on read.
import type { TokenFold } from "./fold.ts";
import { priceOf, type Hop } from "./hop.ts";

export interface PoolLifetime {
  satsIn: bigint; satsOut: bigint; tokensIn: bigint; tokensOut: bigint;
  lpSats: bigint; lpTokens: bigint; validatorSats: bigint; validatorTokens: bigint; commissionSats: bigint; commissionTokens: bigint;
  lastTradeAt: number | null;
}

/** A pool's counters (the `lifetime` its rows carry): a buy's amounts and fees in sats in, a sell's in tokens. */
export function poolLifetime(f: TokenFold, poolId: string): PoolLifetime {
  const p: PoolLifetime = { satsIn: 0n, satsOut: 0n, tokensIn: 0n, tokensOut: 0n, lpSats: 0n, lpTokens: 0n, validatorSats: 0n, validatorTokens: 0n, commissionSats: 0n, commissionTokens: 0n, lastTradeAt: null };
  for (const h of f.hops) {
    if (h.kind !== "swap" || h.poolId !== poolId) continue;
    if (h.side === "buy") { p.satsIn += h.amountIn; p.tokensOut += h.amountOut; p.lpSats += h.feeLp; p.validatorSats += h.feeValidator; p.commissionSats += h.feeCommission; }
    else { p.tokensIn += h.amountIn; p.satsOut += h.amountOut; p.lpTokens += h.feeLp; p.validatorTokens += h.feeValidator; p.commissionTokens += h.feeCommission; }
    p.lastTradeAt = p.lastTradeAt === null ? h.at : Math.max(p.lastTradeAt, h.at);
  }
  return p;
}

/** The token's counters: its volume on each side (each swap's price amounts) and its trade count. */
export function tokenCounters(f: TokenFold): { volumeSats: bigint; volumeTokens: bigint; trades: number } {
  let volumeSats = 0n, volumeTokens = 0n, trades = 0;
  for (const h of f.hops) {
    if (h.kind !== "swap") continue;
    trades++;
    const p = priceOf(h);
    if (p) { volumeSats += p.sats; volumeTokens += p.tokens; }
  }
  return { volumeSats, volumeTokens, trades };
}

/** A pool's LP fees over its swaps (amm-lookup `sumSwaps` on `lp`): a buy's in sats, a sell's in tokens. */
export function lpFees(hops: Hop[]): { sats: bigint; tokens: bigint; swaps: number } {
  let sats = 0n, tokens = 0n, swaps = 0;
  for (const h of hops) { if (h.kind !== "swap") continue; swaps++; if (h.side === "buy") sats += h.feeLp; else tokens += h.feeLp; }
  return { sats, tokens, swaps };
}
