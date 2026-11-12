// The Open Exchange's own /submit door (0.21.0; HANDOFF-2026-11-09 builder call 2 + its CORRECTION and SETTLED lines:
// "the HOST route is the door: it takes POST /submit, hands the body to the instance as the one submit … WITH the topics
// it routed by … and HOLDS THE CLIENT'S CONNECTION ON THE VERDICT EVENT `<app>/topic/tx/<T>` → STEAK or 400"; "A host
// that CALLS submit itself (Open Exchange's door …) knows T and holds/waits on `<app>/topic/tx/<T>`"; CUSTOM HOST:
// routing a topic to its instance, the host-side door, the host's duplicate control). The instance keeps its own HTTP
// /submit route (generic skein); this host does not use it.
//
//   POST /@<handle>/submit and POST /submit (bare host, routed by X-Topics to the instance: skein asks appRead for a topic-routed
//   request before forwarding it) with the BEEF as the body and X-Topics the topics, a JSON array or a comma-separated list (as
//   the skein router reads it: starting with `[` → JSON, else split on `,`, trimmed, empties dropped):
//   1. every named topic must be one the instance serves (host.db `instances.topics`): else 400;
//   2. T = the BEEF's subject (the Atomic BEEF's, else its last transaction);
//   3. answered at once, nothing handed over, ONLY when the submission cannot change anything: T's latest verdict
//      `<app>/topic/tx/<T>` is `admitted` (the same STEAK, read from the facts again). 0.22.0 (David: "Proof always
//      overrides rejected. Rejected is only a guess based on the information we've received. Proof is verifiable"):
//      a recorded `rejected` / `reverted` / `undecided`, or none, is HANDED OVER — the submission may carry the proof;
//      the door keeps nothing of its own, it reads the instance's facts;
//   4. the BEEF handed to the instance as the ONE submit: the submit message to `<app>/submit`, signed as the
//      instance (skein Router `submitAsSelf`), the first topic named; a refusal at the instance's door → 400 with its
//      reason, now;
//   5. the answer is the instance's verdict for THIS submission: the first decided `<app>/topic/tx/<T>` placed after
//      it was handed over → admitted: 200 STEAK {<topic>: {outputsToAdmit, coinsToRetain}}; rejected / reverted: 400.
//      When the instance judged it and placed no new verdict (it stands as it was: e.g. still rejected, no proof), the
//      verdict then standing is the answer. Undecided (paused on parents) → held until it is decided. THE CLIENT'S
//      CONNECTION IS THE ONLY TIMER: when it closes the host stops waiting (nothing is undone: the submission is the
//      instance's).
//   STEAK (INFERRED from the overlay's facts, not read from its state): outputsToAdmit = T's outputs whose latest
//   `<app>/topic/output/<T>.<vout>` is `admitted`; coinsToRetain = T's inputs whose latest `<app>/topic/output/<op>` is
//   `spent` by T (the topic's previous coins T consumed).
import { Beef, Transaction } from "@bsv/sdk";
import { followNew, latest, latestDelivered, type Rec } from "./events.ts";
import { DISCOVERY } from "./exchange.ts";
import type { Router } from "./skein.ts";

type RouterRequest = import("@dcasegr/skein/dist/host/router.js").RouterRequest;
type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;

export const SUBMIT_ROUTE = "/submit";
const TOKEN_ID = /^[0-9a-f]{64}_\d+$/;

/** The overlay app an instance's topics live in (the event prefix and the submit box): a token's `amm`, discovery's `1color`. */
export function overlayApp(handle: string): string | undefined {
  if (TOKEN_ID.test(handle)) return "amm";
  if (handle === DISCOVERY) return "1color";
  return undefined;
}

export type Verdict = { verdict: "admitted"; steak: Rec } | { verdict: "rejected" | "reverted"; reason: string } | { verdict: "refused"; status: number; reason: string } | { verdict: "gone" };

const enc = (s: string) => new TextEncoder().encode(s);
const json = (status: number, v: unknown): RouterResponse => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: enc(JSON.stringify(v)) });
const problem = (status: number, code: string, description: string) => json(status, { status: "error", code, description });

/** The BEEF's subject: the Atomic BEEF's, else its last transaction; and that transaction. */
export function subjectOf(beef: Uint8Array): { txid: string; tx: Transaction } {
  const b = Beef.fromBinary(Array.from(beef));
  const txid = b.atomicTxid ?? b.txs[b.txs.length - 1]?.txid;
  const tx = txid ? b.findTransactionForSigning(txid) : undefined;
  if (!txid || !tx) throw new Error("the BEEF names no transaction");
  return { txid, tx };
}

export class Door {
  private readonly r: Router;
  private readonly say: (line: string) => void;
  constructor(r: Router, say: (line: string) => void) { this.r = r; this.say = say; }

  /** RouterOptions.appRead's share: POST /submit at an instance this host routes topics to; anything else undefined. */
  async route(handle: string, route: string, req: RouterRequest, signal?: AbortSignal): Promise<RouterResponse | undefined> {
    if (route !== SUBMIT_ROUTE || req.method !== "POST") return undefined;
    const app = overlayApp(handle);
    if (!app) return undefined;
    // X-Topics as the skein router reads it (Router.overlayTarget): starts with `[` → a JSON array; else a comma list.
    const h = (req.headers["x-topics"] ?? "").trim();
    let topics: unknown;
    if (h.startsWith("[")) { try { topics = JSON.parse(h); } catch { topics = undefined; } }
    else topics = h.split(",").map((x) => x.trim()).filter(Boolean);
    if (!Array.isArray(topics) || topics.length === 0 || !topics.every((t) => typeof t === "string")) return problem(400, "ERR_BAD_REQUEST", "X-Topics: a JSON array of topic names or a comma-separated list");
    const raw = this.r.o.db.get(handle)?.topics;
    let served: string[] = [];
    try { served = raw ? JSON.parse(raw) as string[] : []; } catch { served = []; }
    const bad = (topics as string[]).find((t) => !served.includes(t));
    if (bad) return problem(400, "ERR_UNSUPPORTED_TOPIC", `${bad}: not a topic of ${handle}`);
    let v: Verdict;
    try { v = await this.submit(handle, req.body, (topics as string[])[0]!, signal); } catch (e) { return problem(400, "ERR_BAD_REQUEST", (e as Error).message); }
    if (v.verdict === "admitted") return json(200, v.steak);
    if (v.verdict === "gone") return problem(503, "ERR_UNAVAILABLE", "the request closed or the instance stopped before a verdict");
    if (v.verdict === "refused") return problem(v.status, "ERR_REFUSED", v.reason);
    return problem(400, v.verdict === "rejected" ? "ERR_REJECTED" : "ERR_REVERTED", v.reason);
  }

  /**
   * One submission through the door: answered at once only for a recorded `admitted`; else handed over and answered
   * from the instance's verdict for it (see the header, 3-5). `signal` (the client's connection) ends the wait.
   */
  async submit(handle: string, beef: Uint8Array, topic: string, signal?: AbortSignal): Promise<Verdict> {
    const app = overlayApp(handle);
    if (!app) throw new Error(`${handle}: no overlay app here`);
    const { txid, tx } = subjectOf(beef);
    const name = `${app}/topic/tx/${txid}`;
    const decided = (rec: Rec | undefined) => !!rec && (rec.verdict === "admitted" || rec.verdict === "rejected" || rec.verdict === "reverted");
    const before = await latestDelivered(this.r, handle, name).catch(() => undefined);
    if (before?.rec.verdict === "admitted") return await this.answer(handle, app, topic, txid, tx, before.rec);
    return await new Promise<Verdict>((resolve) => {
      let done = false, stop: (() => void) | undefined;
      const finish = (v: Verdict) => { if (done) return; done = true; stop?.(); signal?.removeEventListener("abort", onAbort); resolve(v); };
      const onAbort = () => finish({ verdict: "gone" });
      signal?.addEventListener("abort", onAbort);
      const decide = (rec: Rec) => this.answer(handle, app, topic, txid, tx, rec).then(finish, (e: Error) => finish({ verdict: "refused", status: 500, reason: `the STEAK: ${e.message}` }));
      void (async () => {
        try {
          // Only verdicts placed from now on: the one this submission brings.
          stop = await followNew(this.r, handle, { name }, (_n, rec) => { if (decided(rec)) void decide(rec); }, () => finish({ verdict: "gone" }));
          if (done) { stop(); return; }
          const a = await this.r.submitAsSelf(handle, app, beef, topic);
          if (a.verdict === "reject") return finish({ verdict: "refused", status: 400, reason: a.reason ?? "turned away at the door" });
          if (a.verdict === "ignore") return finish({ verdict: "refused", status: 503, reason: a.reason ?? "not taken" });
          // The submission's entry is processed and committed (submitAsSelf returns after it): no new verdict placed →
          // the instance left T as it stood; a decided one then standing is the answer, else (undecided) still held.
          const after = await latestDelivered(this.r, handle, name).catch(() => undefined);
          if (!done && after && after.place === before?.place && decided(after.rec)) void decide(after.rec);
        } catch (e) { finish({ verdict: "refused", status: 503, reason: (e as Error).message }); }
      })();
    });
  }

  private async answer(handle: string, app: string, topic: string, txid: string, tx: Transaction, rec: Rec): Promise<Verdict> {
    if (rec.verdict !== "admitted") return { verdict: rec.verdict as "rejected" | "reverted", reason: typeof rec.reason === "string" ? rec.reason : String(rec.verdict) };
    const outputsToAdmit: number[] = [], coinsToRetain: number[] = [];
    for (let v = 0; v < tx.outputs.length; v++) {
      const o = await latest(this.r, handle, `${app}/topic/output/${txid}.${v}`).catch(() => undefined);
      if (o?.state === "admitted") outputsToAdmit.push(v);
    }
    for (let i = 0; i < tx.inputs.length; i++) {
      const inp = tx.inputs[i]!;
      const src = inp.sourceTXID ?? inp.sourceTransaction?.id("hex");
      if (!src) continue;
      const o = await latest(this.r, handle, `${app}/topic/output/${src}.${inp.sourceOutputIndex}`).catch(() => undefined);
      if (o?.state === "spent" && o.spentBy === txid) coinsToRetain.push(i);
    }
    this.say(`${handle}: door: ${txid.slice(0, 8)}… admitted (${outputsToAdmit.length} outputs)`);
    return { verdict: "admitted", steak: { [topic]: { outputsToAdmit, coinsToRetain } } };
  }
}
