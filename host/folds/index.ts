// The host's following of the token instances (0.21.0; the analytics store from David 2026-11-12): `ensure(tokenId)`
// subscribes to the instance's `amm/hop` events AFTER the last place the analytics store took from it (none stored:
// from place zero) — the events since then replayed, then live (host/events.ts `followAll`) — and each event goes
// into the store (host/analytics.ts `take`, one transaction with the head). The stream's end (the instance stopped)
// drops the subscription, and the next read follows it again from the stored place. Nothing about swaps in memory.
import { HOP_EVENT, type Hop } from "./hop.ts";
import { followAll, latest } from "../events.ts";
import { skein, type Router } from "../skein.ts";
import type { Analytics } from "../analytics.ts";

type EventsMod = typeof import("@dcasegr/skein/dist/host/events.js");

export class Folds {
  private readonly router: Router;
  private readonly say: (line: string) => void;
  readonly store: Analytics;
  private readonly folds = new Map<string, { ready: Promise<void>; stop?: () => void }>();
  /** Each hop taken live, with its token (the pool feeds). */
  onHop?: (tokenId: string, h: Hop) => void;

  constructor(router: Router, say: (line: string) => void, store: Analytics) { this.router = router; this.say = say; this.store = store; }

  /** The token instance followed into the store (caught up), following it first when it is not followed yet. */
  ensure(tokenId: string): Promise<void> {
    const had = this.folds.get(tokenId);
    if (had) return had.ready;
    // The catch-up is not news: only hops taken after it go to the feeds.
    let live = false, n = 0;
    const slot: { ready: Promise<void>; stop?: () => void } = { ready: Promise.resolve() };
    slot.ready = (async () => {
      const head = this.store.head(tokenId);
      const after = head === undefined ? undefined : (await skein<EventsMod>("src/host/events.ts")).placeOf(head);
      slot.stop = await followAll(this.router, tokenId, { name: HOP_EVENT, ...(after ? { after } : {}) }, (_n, rec, d) => {
        const h = this.store.take(tokenId, rec, d.id);
        if (live) { if (h) this.onHop?.(tokenId, h); } else n++;
      }, () => { if (this.folds.get(tokenId) === slot) this.folds.delete(tokenId); });
      live = true;
      this.say(`${tokenId}: ${n} events caught up after ${head ?? "place zero"}, following ${HOP_EVENT}`);
    })();
    slot.ready.catch((e) => { this.folds.delete(tokenId); this.say(`${tokenId}: not followed: ${(e as Error).message}`); });
    this.folds.set(tokenId, slot);
    return slot.ready;
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
