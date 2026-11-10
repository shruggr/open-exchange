// The host's folds, one per enabled token instance (0.21.0): `ensure(tokenId)` follows the instance's `amm/hop` events
// from place zero (replayed, then live; host/events.ts `followAll`) into a TokenFold; the stream's end (the instance
// stopped) drops it, and the next read follows it again. Nothing written anywhere: a restart replays.
import { TokenFold } from "./fold.ts";
import { HOP_EVENT, type Hop } from "./hop.ts";
import { followAll, latest } from "../events.ts";
import type { Router } from "../skein.ts";

export class Folds {
  private readonly router: Router;
  private readonly say: (line: string) => void;
  private readonly folds = new Map<string, { fold: Promise<TokenFold>; stop?: () => void }>();
  /** Each hop folded, with its token (the pool feeds). */
  onHop?: (tokenId: string, h: Hop) => void;

  constructor(router: Router, say: (line: string) => void) { this.router = router; this.say = say; }

  /** The token instance's fold, following it first when it is not followed yet. */
  ensure(tokenId: string): Promise<TokenFold> {
    const had = this.folds.get(tokenId);
    if (had) return had.fold;
    const f = new TokenFold(tokenId);
    // The replay is not news: only hops folded after it go to the feeds.
    let live = false;
    f.onHop = (h) => { if (live) this.onHop?.(tokenId, h); };
    const slot: { fold: Promise<TokenFold>; stop?: () => void } = { fold: Promise.resolve(f) };
    slot.fold = (async () => {
      slot.stop = await followAll(this.router, tokenId, { name: HOP_EVENT }, (_n, rec, d) => { f.take(rec, d.id); }, () => { if (this.folds.get(tokenId) === slot) this.folds.delete(tokenId); });
      live = true;
      this.say(`${tokenId}: fold: ${f.hops.length} hops replayed, following ${HOP_EVENT}`);
      return f;
    })();
    slot.fold.catch((e) => { this.folds.delete(tokenId); this.say(`${tokenId}: fold: not followed: ${(e as Error).message}`); });
    this.folds.set(tokenId, slot);
    return slot.fold;
  }

  /** A transaction's block height, from its latest `chain/tx/<txid>` on the token instance when it says mined; else null. */
  async heightOf(tokenId: string, txid: string): Promise<number | null> {
    const r = await latest(this.router, tokenId, `chain/tx/${txid}`).catch(() => undefined);
    return r?.status === "mined" && typeof r.height === "number" ? r.height : null;
  }

  /** Stop following every token. */
  stop(): void {
    for (const s of this.folds.values()) s.stop?.();
    this.folds.clear();
  }
}
