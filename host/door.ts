// The Open Exchange's own /submit door (0.21.0; HANDOFF-2026-11-09 builder call 2 + its CORRECTION and SETTLED lines:
// "the HOST route is the door: it takes POST /submit, hands the body to the instance as the one submit … WITH the topics
// it routed by … and HOLDS THE CLIENT'S CONNECTION ON THE VERDICT EVENT `<app>/topic/tx/<T>` → STEAK or 400"; "A host
// that CALLS submit itself (Open Exchange's door …) knows T and holds/waits on `<app>/topic/tx/<T>`"; CUSTOM HOST:
// routing a topic to its instance, the host-side door, the host's duplicate control). The instance keeps its own HTTP
// /submit route (generic skein); this host does not use it.
//
//   POST /@<handle>/submit and POST /submit (bare host, routed by X-Topics to the instance: skein F1, appRead asked for a
//   topic-routed request — NOT in skein yet) with the BEEF as the body and X-Topics a JSON array of topics:
//   1. every named topic must be one the instance serves (host.db `instances.topics`): else 400;
//   2. T = the BEEF's subject (the Atomic BEEF's, else its last transaction);
//   3. duplicate control: T's latest verdict `<app>/topic/tx/<T>` already admitted / rejected / reverted → answered from
//      it at once, nothing handed over;
//   4. else the BEEF handed to the instance as the ONE submit: the submit message to `<app>/submit`, signed as the
//      instance (skein Router `submitAsSelf`, F2 — private in skein today, reached by bracket access), the first topic
//      named; a refusal at the instance's door → 400 with its reason, now;
//   5. the connection held on `<app>/topic/tx/<T>`: admitted → 200 STEAK {<topic>: {outputsToAdmit, coinsToRetain}};
//      rejected / reverted → 400; undecided → still held. THE CLIENT'S CONNECTION IS THE ONLY TIMER: when it closes the
//      host stops waiting (nothing is undone: the submission is the instance's).
//   STEAK (INFERRED from the overlay's facts, not read from its state): outputsToAdmit = T's outputs whose latest
//   `<app>/topic/output/<T>.<vout>` is `admitted`; coinsToRetain = T's inputs whose latest `<app>/topic/output/<op>` is
//   `spent` by T (the topic's previous coins T consumed).
import { Beef, Transaction } from "@bsv/sdk";
import { followAll, latest, type Rec } from "./events.ts";
import { DISCOVERY } from "./exchange.ts";
import type { Router } from "./skein.ts";

type RouterRequest = import("@dcasegr/skein/dist/host/router.js").RouterRequest;
type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;
type InboundAnswer = { verdict: "accept" | "reject" | "ignore"; reason?: string };

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
    let topics: unknown;
    try { topics = JSON.parse(req.headers["x-topics"] ?? ""); } catch { topics = undefined; }
    if (!Array.isArray(topics) || topics.length === 0 || !topics.every((t) => typeof t === "string")) return problem(400, "ERR_BAD_REQUEST", "X-Topics: a JSON array of topic names");
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
   * One submission through the door: T's verdict, waited for on `<app>/topic/tx/<T>` (an existing one answered at once).
   * `signal` (the client's connection) ends the wait.
   */
  async submit(handle: string, beef: Uint8Array, topic: string, signal?: AbortSignal): Promise<Verdict> {
    const app = overlayApp(handle);
    if (!app) throw new Error(`${handle}: no overlay app here`);
    const { txid, tx } = subjectOf(beef);
    const name = `${app}/topic/tx/${txid}`;
    const decided = (rec: Rec | undefined) => rec && (rec.verdict === "admitted" || rec.verdict === "rejected" || rec.verdict === "reverted");
    const now = await latest(this.r, handle, name).catch(() => undefined);
    if (decided(now)) return await this.answer(handle, app, topic, txid, tx, now!);
    return await new Promise<Verdict>((resolve) => {
      let done = false, stop: (() => void) | undefined;
      const finish = (v: Verdict) => { if (done) return; done = true; stop?.(); signal?.removeEventListener("abort", onAbort); resolve(v); };
      const onAbort = () => finish({ verdict: "gone" });
      signal?.addEventListener("abort", onAbort);
      void (async () => {
        try {
          stop = await followAll(this.r, handle, { name }, (_n, rec) => { if (decided(rec)) void this.answer(handle, app, topic, txid, tx, rec).then(finish); }, () => finish({ verdict: "gone" }));
          if (done) { stop(); return; }
          const a = await (this.r as unknown as { submitAsSelf(h: string, app: string, beef: Uint8Array, topic: string): Promise<InboundAnswer> }).submitAsSelf(handle, app, beef, topic);
          if (a.verdict === "reject") finish({ verdict: "refused", status: 400, reason: a.reason ?? "turned away at the door" });
          else if (a.verdict === "ignore") finish({ verdict: "refused", status: 503, reason: a.reason ?? "not taken" });
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
