// The swap relay's answer (0.23.0, rule 10) against a stub host: a relayed reply carrying a signed transaction is
// answered once THIS host's broadcast of it is taken by Arcade (Router.broadcastTaken, held before the take-in);
// refused by Arcade as invalid, the page gets {ok: false, reason: "rejected", detail}; a refusal (no transaction) is
// answered at once after its BEEF is taken in; the local validator's reply (held in skein's p2pInbound) as it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as dagCbor from "@ipld/dag-cbor";
import { P2PKH, PrivateKey, Transaction, UnlockingScript, LockingScript } from "@bsv/sdk";
import { POOL_SLOTS, POOL_TEMPLATE_HEX, PARAM_ASSET_ID } from "./pool-code.ts";
import { Relay } from "./relay.ts";

type Taken = { taken: true } | { taken: false; reason: string } | { gone: true };
const TOKEN = `${"ab".repeat(32)}_0`;
const b64 = (b: Uint8Array) => ({ "/": { bytes: Buffer.from(b).toString("base64").replace(/=+$/, "") } });

/** A pool continuation (1Color prefix + the Pool code, every fee 0) and a Swap call's 13 pushes: the commission rule passes. */
function swapTx(): { swap: Transaction; funding: Transaction } {
  const tpl = Buffer.from(POOL_TEMPLATE_HEX, "hex");
  const parts: Buffer[] = [Buffer.from([0x20]), Buffer.alloc(32, 7), Buffer.from([0x01, 0x05, 0x6d])];
  let at = 0;
  for (const s of POOL_SLOTS) {
    parts.push(tpl.subarray(at, s.offset));
    parts.push(s.param === PARAM_ASSET_ID ? Buffer.concat([Buffer.from([0x20]), Buffer.alloc(32, 9)]) : Buffer.from([0x00]));
    at = s.offset + 1;
  }
  parts.push(tpl.subarray(at));
  const pushes: Buffer[] = [];
  for (let i = 0; i < 13; i++) {
    if (i === 3) pushes.push(Buffer.from([0x01, 0x05]));
    else if (i === 6) pushes.push(Buffer.concat([Buffer.from([0x14]), Buffer.alloc(20, 1)]));
    else pushes.push(Buffer.from([0x00]));
  }
  const k = new PrivateKey(42);
  const funding = new Transaction();
  funding.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  funding.addOutput({ lockingScript: new P2PKH().lock(k.toPublicKey().toHash()), satoshis: 1000 });
  const swap = new Transaction();
  swap.addInput({ sourceTXID: "22".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromBinary([...Buffer.concat(pushes)]), sequence: 0xffffffff });
  swap.addInput({ sourceTXID: funding.id("hex"), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  swap.addOutput({ lockingScript: LockingScript.fromBinary([...Buffer.concat(parts)]), satoshis: 1 });
  return { swap, funding };
}

/** A stub host: the validator's frame given, the take-in recorded, the hold on this host's broadcast controlled. */
function host(frame: Uint8Array, o: { local?: boolean } = {}) {
  const calls: string[] = [];
  let release: ((t: Taken) => void) | undefined;
  const router = {
    o: { db: { get: (h: string) => (h === TOKEN ? { status: "enabled" } : undefined) } },
    hydrate: async () => ({ wallet: { getPublicKey: async () => ({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() }) } }),
    signMessage: async (_h: string, m: { body: Uint8Array }) => ({ message: { kind: "mail" }, body: m.body }),
    p2p: { peerId: () => (o.local ? "QmPeerV" : "QmPeerX"), call: async () => { calls.push("call"); return { body: frame }; } },
    p2pInbound: async () => { calls.push("p2pInbound"); return { verdict: "accept", body: frame }; },
    submitAsSelf: async (h: string, app: string, _beef: Uint8Array, topic: string) => { calls.push(`takeIn ${h === TOKEN} ${app} ${topic === `tm_color_${TOKEN}`}`); return { verdict: "accept" }; },
    broadcastTaken: (_h: string, txid: string) => { calls.push(`hold ${txid}`); return new Promise<Taken>((r) => { release = r; }); },
  };
  const sk = { cid: { encode: (v: unknown) => ({ bytes: dagCbor.encode(v) }), decode: (b: Uint8Array) => dagCbor.decode(b) } };
  const relay = new Relay({ router: router as never, sk: sk as never, log: () => {} });
  return { relay, calls, release: (t: Taken) => release!(t), held: () => release !== undefined };
}

function request(swap: Transaction, funding: Transaction): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    funding: b64(Uint8Array.from(funding.toBinary())), swap: b64(Uint8Array.from(swap.toBinary())), pool: `${"22".repeat(32)}_0`,
    validator: b64(Uint8Array.from(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])), peerId: "QmPeerV",
  }));
}

const answerOf = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;

test("relay: a relayed accepted swap is answered once this host's broadcast of it is taken; the hold before the take-in", async () => {
  const { swap, funding } = swapTx();
  const signed = Uint8Array.from(swap.toBinary());
  const T = swap.id("hex");
  const h = host(dagCbor.encode({ ok: true, tx: signed, txid: T, beef: Uint8Array.from([1, 2, 3]) }));
  let out: Record<string, unknown> | undefined;
  const p = h.relay.swap(TOKEN, request(swap, funding)).then((r) => { out = answerOf(r.body); });
  for (let i = 0; i < 50 && !h.held(); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(out, undefined, "held: this host's broadcast not taken yet");
  assert.deepEqual(h.calls, ["call", `hold ${T}`, "takeIn true amm true"], "the hold registered, then the BEEF taken into this instance");
  h.release({ taken: true });
  await p;
  assert.equal(out!.ok, true);
  assert.equal(out!.txid, T, "the validator's reply as it is");
});

test("relay: a relayed swap Arcade refuses as invalid → {ok: false, reason: rejected, detail: Arcade's reason}", async () => {
  const { swap, funding } = swapTx();
  const h = host(dagCbor.encode({ ok: true, tx: Uint8Array.from(swap.toBinary()), txid: swap.id("hex"), beef: Uint8Array.from([1]) }));
  const p = h.relay.swap(TOKEN, request(swap, funding));
  for (let i = 0; i < 50 && !h.held(); i++) await new Promise((r) => setTimeout(r, 5));
  h.release({ taken: false, reason: "fee is too low" });
  assert.deepEqual(answerOf((await p).body), { ok: false, reason: "rejected", detail: "fee is too low" });
});

test("relay: a refusal (no signed transaction: nothing broadcast) is answered at once, its BEEF taken in", async () => {
  const { swap, funding } = swapTx();
  const h = host(dagCbor.encode({ ok: false, reason: "pool_spent", beef: Uint8Array.from([1]) }));
  const r = answerOf((await h.relay.swap(TOKEN, request(swap, funding))).body);
  assert.equal(r.reason, "pool_spent");
  assert.deepEqual(h.calls, ["call", "takeIn true amm true"], "no hold");
});

test("relay: the local validator's reply (held already in skein's p2pInbound) is answered as it is: no take-in, no second hold", async () => {
  const { swap, funding } = swapTx();
  const h = host(dagCbor.encode({ ok: true, tx: Uint8Array.from(swap.toBinary()), txid: swap.id("hex"), beef: Uint8Array.from([1]) }), { local: true });
  const r = answerOf((await h.relay.swap(TOKEN, request(swap, funding))).body);
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls, ["p2pInbound"]);
});
