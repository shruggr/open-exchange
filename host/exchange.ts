// The Open Exchange host's reactions (shruggr/open-exchange#1, shruggr/skein#164). The swap instance
// records root's decisions as facts and emits each as an event; the host — this — materializes them.
// Nothing answers back: swap's log is the fact, the host's instance table is derived state, rebuilt
// from swap's heads at every start (`reconcile`).
//
//   token-enabled {tokenId, beef, terms?, market?}   no instance <tokenId>: one from the image `token`,
//       born owned by the host's key (#164), routed by [tm_color_<id>, ls_color_<id>, ls_amm_<id>],
//       created DISABLED; the deploy fed in as the event {kind: "deploy", beef} in amm/deploy (the
//       door checks the BEEF, #121); admitted → published (enabled), then `terms` and `market` as
//       root's messages (signed by the host's key) into amm/validator and amm/amm-p2p; refused at
//       the door → the instance removed (a file store), or left disabled (a store in the host's
//       RocksDB/LMDB database: its set cannot be removed, so the handle cannot be created again).
//       An instance there already: started if stopped, its deploy fed in if it has no token yet.
//   token-disabled {tokenId}      the instance stopped (disabled; its libp2p node left). Not removed.
//   token-terms {tokenId, terms}  (0.12.0; 0.14.0 terms may carry minLegSats) root's terms for one token: sent to its instance as root's
//       `terms` message into amm/validator (`terms` a map, or null = market only), as at creation. No
//       instance: logged, nothing else. Not replayed at start: the instance keeps its own amm/terms.
//   discovery-on / discovery-off  the instance `discovery` (made on the first run) started / stopped.
//   claimed {claimant}            (0.5.0) the first wallet's claim on swap: the role `amm.admin` granted to
//       the claimant on swap by root's `grant` (the host's key is root on swap: swap is born owned by
//       it); the claimant configures (the box amm/admin), it is not root. Already granted: nothing sent.
//
// At start (0.5.0), before the reconcile: the packaged swap app (apps/swap) installed into swap when its
// version differs from the installed one (swap's head amm/app), as the host's key (root) — the pages
// follow the package on `npm install open-exchange@<v>` + a restart. Then the reconcile re-grants
// amm.admin to swap's claimant if a crash came between the claim and the grant.
//
// At start (0.20.1), after the reconcile: every token instance and discovery (enabled) gets its image's packaged
// apps in place — each {url, hash} entry of image/<token|discovery>/etc/apps.json, fetched once (skein's
// appTarball, checked against its tree id) when the instance's installed app of that name is not that tree — when
// the packaged version differs from the installed one (its head <app>/app), as root (the host's key), as the swap
// app's. (0.21.0: no reindex — the overlay has none since 0.24.0; an instance's index is the kernel's.)
//
// Each reaction is idempotent and logged; they run one at a time, in the order handed over.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGES_DIR, SWAP_APP_DIR, swapAppVersion, type Router, type Skein } from "./skein.ts";

export const SWAP = "swap";
export const DISCOVERY = "discovery";
/** The swap app's name: the events are its (the record's `app`, the kernel's). */
export const SWAP_APP = "amm";
export const TOKEN_IMAGE = "token";
/** The role swap's claimant is granted (the swap app's role admin, which gates the box amm/admin). */
export const ADMIN_ROLE = `${SWAP_APP}.admin`;
const KEY = /^0[23][0-9a-f]{64}$/;
const TOKEN_ID = /^[0-9a-f]{64}_\d+$/;

export const tokenTopics = (id: string) => [`tm_color_${id}`, `ls_color_${id}`, `ls_amm_${id}`];
export const DISCOVERY_TOPICS = ["tm_color", "ls_color"];

type Rec = Record<string, unknown>;
/** Root's terms as the swap app carries them (0.14.0: `minLegSats`, the validator's minimum leg in sats, optional), passed through untouched. */
type Terms = { lpFeeBps: number; validatorFeeBps: number; commissionBps: number; minLegSats?: number };
type Market = { minCommissionBps: number };

export interface ExchangeOptions {
  sk: Skein;
  router: Router;
  /** The host's key (one-key mode): its identity (hex) owns every instance; its wallet signs root's messages. */
  hostKey: string;
  hostWallet: import("@dcasegr/skein/dist/host/signer.js").Signer extends { wallet(h: string): infer W } ? W : never;
  log(line: string): void;
  /** The swap app installed into swap at start when its version differs (default: the package's apps/swap; tests'). */
  swapAppDir?: string;
  /** 0.20.1: the images whose packaged apps the token instances and discovery get at start (default: the package's image/; tests'). */
  imagesDir?: string;
}

/** An image's app by release tarball (etc/apps.json `install`: `{url, hash}`, `hash` its tree's git id). */
type ImageEntry = { url: string; hash: string };
/** A packaged app as fetched: its name, version and its tree as an install reads it. */
type Packaged = { app: string; version: string; tree: Awaited<ReturnType<Skein["install"]["readApp"]>> };
/** An installed app (its head <app>/app): its version and tree id (hex). */
type Installed = { version?: string; tree?: string };

export class Exchange {
  private readonly o: ExchangeOptions;
  private chain: Promise<void> = Promise.resolve();
  /** 0.20.1: the packaged apps fetched this run, by tree id (once each). */
  private readonly fetched = new Map<string, Promise<Packaged>>();

  constructor(o: ExchangeOptions) { this.o = o; }

  private get r(): Router { return this.o.router; }
  private say(line: string): void { this.o.log(line); }
  /** The router's private parts this host reuses (the instance manager's start/stop, the host chain's start event). */
  private get internals(): {
    manage(box: string, b: Rec): Promise<Rec>;
    chainBirth(handle: string): Promise<void>;
    queues: Map<string, Promise<unknown>>;
  } { return this.r as unknown as never; }

  /** An emitted event from `handle` (Router `appEvent`): swap's, by its app; queued. */
  event(handle: string, rec: Rec): void {
    if (handle !== SWAP || rec.app !== SWAP_APP) { this.say(`${handle}: event ${String(rec.event)}${rec.app ? ` (app ${String(rec.app)})` : ""}: not swap's: ignored`); return; }
    const name = String(rec.event);
    const run = (): Promise<void> => {
      switch (name) {
        case "token-enabled": return this.tokenEnabled(rec);
        case "token-disabled": return this.tokenDisabled(rec);
        case "token-terms": return this.tokenTerms(rec);
        case "discovery-on": return this.discovery(true);
        case "discovery-off": return this.discovery(false);
        case "claimed": return this.claimed(rec);
        default: this.say(`swap: event ${name}: no reaction`); return Promise.resolve();
      }
    };
    this.enqueue(`${name}${typeof rec.tokenId === "string" ? ` ${rec.tokenId}` : ""}`, run);
  }

  private enqueue(what: string, f: () => Promise<void>): Promise<void> {
    const p = this.chain.then(f).catch((e) => this.say(`${what}: ${(e as Error).stack ?? e}`));
    this.chain = p;
    return p;
  }

  /** Until every queued reaction has run. */
  async idle(): Promise<void> { let c; do { c = this.chain; await c; } while (c !== this.chain); }

  // ---------------------------------------------------------------- the reactions

  async tokenEnabled(rec: Rec): Promise<void> {
    const id = typeof rec.tokenId === "string" ? rec.tokenId : "";
    if (!TOKEN_ID.test(id)) { this.say(`token-enabled: ${JSON.stringify(rec.tokenId)} is not a token id: ignored`); return; }
    const beef = rec.beef instanceof Uint8Array ? rec.beef : undefined;
    const db = this.r.o.db;
    const row = db.get(id);
    if (row) {
      if (row.status !== "enabled") await this.start(id, tokenTopics(id));
      // An instance with no token yet (its deploy refused before, or never fed): fed now.
      if (!(await this.hasToken(id))) {
        if (!beef) { this.say(`${id}: running, no token, and no BEEF to feed it`); return; }
        if (!(await this.feedDeploy(id, beef))) { await this.stop(id); return; }
        await this.terms(id, rec);
      } else this.say(`${id}: token-enabled: its instance runs (${row.status === "enabled" ? "was running" : "started"})`);
      return;
    }
    if (!beef) { this.say(`token-enabled ${id}: no BEEF: not created`); return; }
    const t0 = Date.now();
    await this.r.createInstance(id, this.o.hostKey, { image: TOKEN_IMAGE, owned: true, publish: false, topics: tokenTopics(id) });
    if (!(await this.feedDeploy(id, beef))) {
      const store = db.get(id)?.store ?? "";
      if (/^(rocksdb|lmdb):/.test(store)) {
        await this.stop(id);
        this.say(`${id}: its deploy refused: the instance left DISABLED (its set in ${store.replace(/#.*/, "")} cannot be removed, so the handle cannot be created again; an enable with a good BEEF feeds it)`);
      } else {
        await this.r.reclaim(id);
        this.say(`${id}: its deploy refused: the instance removed`);
      }
      return;
    }
    await this.start(id, tokenTopics(id));
    await this.terms(id, rec);
    this.say(`${id}: token-enabled: created from image ${TOKEN_IMAGE}, owned by the host's key, its deploy admitted, published at ${this.r.originOf(id)} (${Date.now() - t0} ms)`);
  }

  async tokenDisabled(rec: Rec): Promise<void> {
    const id = typeof rec.tokenId === "string" ? rec.tokenId : "";
    if (!TOKEN_ID.test(id)) { this.say(`token-disabled: ${JSON.stringify(rec.tokenId)} is not a token id: ignored`); return; }
    const row = this.r.o.db.get(id);
    if (!row) { this.say(`${id}: token-disabled: no instance here: nothing to stop`); return; }
    if (row.status !== "enabled") { this.say(`${id}: token-disabled: stopped already`); return; }
    await this.stop(id);
    this.say(`${id}: token-disabled: stopped`);
  }

  /** 0.12.0: one token's terms (root's, on swap) to its instance; the instance's amm/terms is the record. */
  async tokenTerms(rec: Rec): Promise<void> {
    const id = typeof rec.tokenId === "string" ? rec.tokenId : "";
    if (!TOKEN_ID.test(id)) { this.say(`token-terms: ${JSON.stringify(rec.tokenId)} is not a token id: ignored`); return; }
    if (!this.r.o.db.get(id)) { this.say(`${id}: token-terms: no instance here: nothing sent`); return; }
    await this.sendTerms(id, (rec.terms ?? null) as Terms | null);
  }

  async discovery(on: boolean): Promise<void> {
    const row = this.r.o.db.get(DISCOVERY);
    if (!row) { this.say(`discovery-${on ? "on" : "off"}: no instance ${DISCOVERY} (the first run makes it)`); return; }
    if (on === (row.status === "enabled")) { this.say(`discovery-${on ? "on" : "off"}: ${on ? "running" : "stopped"} already`); return; }
    if (on) await this.start(DISCOVERY, DISCOVERY_TOPICS); else await this.stop(DISCOVERY);
    this.say(`discovery-${on ? "on" : "off"}: ${DISCOVERY} ${on ? "started" : "stopped"}`);
  }

  /** swap's claim: the claimant granted amm.admin on swap (root's `grant`, signed by the host's key). */
  async claimed(rec: Rec): Promise<void> {
    const k = typeof rec.claimant === "string" ? rec.claimant.toLowerCase() : "";
    if (!KEY.test(k)) { this.say(`claimed: ${JSON.stringify(rec.claimant)} is not an identity key: ignored`); return; }
    if ((await this.holders(SWAP, ADMIN_ROLE)).includes(k)) { this.say(`claimed: ${k.slice(0, 8)}… holds ${ADMIN_ROLE} on ${SWAP} already`); return; }
    if (!(await this.holders(SWAP, "root")).includes(this.o.hostKey)) { this.say(`claimed: ${k.slice(0, 8)}… claimed ${SWAP}, but the host's key is not root on ${SWAP} (an install made by 0.3.0–0.4.5): ${ADMIN_ROLE} NOT granted`); return; }
    await this.rootMessage(SWAP, "grant", { op: "add", role: ADMIN_ROLE, principal: Uint8Array.from(Buffer.from(k, "hex")) });
    this.say(`claimed: ${ADMIN_ROLE} on ${SWAP} granted to ${k}`);
  }

  // ---------------------------------------------------------------- the steps

  /** The keys (hex) holding `role` on an instance (its head `grants`). */
  async holders(handle: string, role: string): Promise<string[]> {
    const l = await this.r.hydrate(handle);
    const root = await l.kernel.call("head", "grants");
    if (!root) return [];
    const g = await l.kernel.store.get(root as never).catch(() => undefined) as { roles?: Record<string, Uint8Array[]> } | undefined;
    return (g?.roles?.[role] ?? []).map((k) => Buffer.from(k).toString("hex"));
  }

  /** The swap app's version installed in swap (its head amm/app), or undefined. */
  async swapVersion(): Promise<string | undefined> {
    const l = await this.r.hydrate(SWAP);
    const c = await l.kernel.call("head", `${SWAP_APP}/app`);
    if (!c) return undefined;
    const rec = await l.kernel.store.get(c as never).catch(() => undefined) as { version?: string } | undefined;
    return rec?.version;
  }

  /**
   * The packaged swap app into swap when its version differs from the installed one: planned as
   * `skein install` plans (planInstallApp: objects, the head amm/app, dispatch, start) over swap's store,
   * each message sent as root's (the host's key). Queued; logged.
   */
  updateSwap(): Promise<void> {
    return this.enqueue("swap pages", async () => {
      const row = this.r.o.db.get(SWAP);
      if (!row || row.status !== "enabled") return;
      const dir = this.o.swapAppDir ?? SWAP_APP_DIR;
      const want = swapAppVersion(dir), have = await this.swapVersion();
      if (have === want) { this.say(`swap: pages at ${want} (the package's)`); return; }
      if (!(await this.holders(SWAP, "root")).includes(this.o.hostKey)) {
        this.say(`swap: WARNING: the package's pages are ${want}, ${SWAP} runs ${have ?? "none"}, and the host's key is not root on ${SWAP} (an install made by open-exchange 0.3.0–0.4.5): not updated`);
        return;
      }
      const n = await this.installTree(SWAP, SWAP_APP, await this.o.sk.install.readApp(dir), want);
      this.say(`swap: pages updated to ${want} (from ${have ?? "none"}; ${n} messages as root)`);
    });
  }

  /**
   * An app's tree into an instance in place: planned as `skein install` plans (planInstallApp: objects, the head
   * <app>/app, dispatch, start) over the instance's store, each message sent as root's (the host's key); until the
   * head <app>/app names `want` (120 s). → the messages sent.
   */
  private async installTree(handle: string, app: string, tree: Packaged["tree"], want: string): Promise<number> {
    const sk = this.o.sk;
    const row = this.r.o.db.get(handle)!;
    const st = sk.stores.openStoreFile(sk.indexStore.storeSpec(row), { readOnly: true });
    let plan;
    try { plan = await sk.admin.planInstallApp(tree, await sk.install.instanceView(st as never), { modules: sk.boot.wasmDirObjects(sk.boot.WASM_DIR) }); } finally { st.close(); }
    for (const m of plan.messages) await this.rootMessage(handle, m.box, m.body as Rec);
    for (const end = Date.now() + 120_000; ;) {
      await this.r.loaded.get(handle)?.kernel.idle().catch(() => {});
      if ((await this.installedApp(handle, app)).version === want) break;
      if (Date.now() > end) throw new Error(`${handle}: ${app}/app is not ${want} 120 s after the install (${plan.messages.length} messages sent; its log says why)`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return plan.messages.length;
  }

  // ---------------------------------------------------------------- the managed instances' apps (0.20.1)

  /** An installed app of an instance (its head <app>/app's record). */
  private async installedApp(handle: string, app: string): Promise<Installed> {
    const l = await this.r.hydrate(handle);
    const c = await l.kernel.call("head", `${app}/app`);
    if (!c) return {};
    const rec = await l.kernel.store.get(c as never).catch(() => undefined) as { version?: string; tree?: { multihash?: { digest?: Uint8Array } } } | undefined;
    const d = rec?.tree?.multihash?.digest;
    return { version: rec?.version, tree: d ? Buffer.from(d).toString("hex") : undefined };
  }

  /** The installed apps' tree ids (hex) on an instance: its heads <app>/app. */
  private async installedTrees(handle: string): Promise<Set<string>> {
    const sk = this.o.sk;
    const st = sk.stores.openStoreFile(sk.indexStore.storeSpec(this.r.o.db.get(handle)!), { readOnly: true });
    try {
      const v = await sk.install.instanceView(st as never);
      const out = new Set<string>();
      for (const h of v.heads) {
        if (!h.name.endsWith("/app") || h.name.indexOf("/") !== h.name.length - 4) continue;
        const rec = await v.store.get(h.root as never).catch(() => undefined) as { kind?: string; tree?: { multihash?: { digest?: Uint8Array } } } | undefined;
        const d = rec?.kind === "app" ? rec.tree?.multihash?.digest : undefined;
        if (d) out.add(Buffer.from(d).toString("hex"));
      }
      return out;
    } finally { st.close(); }
  }

  /** An image's apps by tarball (its etc/apps.json `install`, the `{url, hash}` entries, in order). */
  private imageEntries(image: string): ImageEntry[] {
    const j = JSON.parse(readFileSync(join(this.o.imagesDir ?? IMAGES_DIR, image, "etc", "apps.json"), "utf8")) as { install?: unknown[] };
    return (j.install ?? []).filter((a): a is ImageEntry => !!a && typeof a === "object" && typeof (a as ImageEntry).url === "string" && typeof (a as ImageEntry).hash === "string");
  }

  /** A packaged app by its tarball, fetched once this run (skein's appTarball: checked against its tree id) and read as an install reads a stored app. */
  private packagedApp(e: ImageEntry): Promise<Packaged> {
    let p = this.fetched.get(e.hash);
    if (!p) {
      p = (async () => {
        const sk = this.o.sk;
        const mem = new sk.boot.MemBlocks();
        const root = await sk.boot.appTarball(e, mem, mem);
        const t = await sk.install.readStoredApp(mem as never, root);
        const m = t.checked.manifest;
        return { app: m.name, version: m.version, tree: { ...t, records: [...mem.map.values()] } };
      })();
      this.fetched.set(e.hash, p);
      p.catch(() => this.fetched.delete(e.hash));
    }
    return p;
  }

  /**
   * At start, after the reconcile: each enabled token instance (image `token`) and discovery (image `discovery`)
   * gets its image's packaged apps when their versions differ from the installed ones. Queued; logged.
   */
  updateInstances(): Promise<void> {
    return this.enqueue("instances", async () => {
      for (const row of this.r.o.db.list("enabled")) {
        const h = row.handle;
        const image = TOKEN_ID.test(h) ? TOKEN_IMAGE : h === DISCOVERY ? DISCOVERY : undefined;
        if (!image) continue;
        await this.updateInstance(h, image).catch((e) => this.say(`${h}: its apps not updated: ${(e as Error).message}`));
      }
    });
  }

  private async updateInstance(h: string, image: string): Promise<void> {
    if (!(await this.holders(h, "root")).includes(this.o.hostKey)) { this.say(`${h}: WARNING: the host's key is not root here: its apps not updated`); return; }
    const trees = await this.installedTrees(h);
    for (const e of this.imageEntries(image)) {
      if (trees.has(e.hash)) continue;
      const p = await this.packagedApp(e);
      const have = await this.installedApp(h, p.app);
      if (have.version === p.version) continue;
      const n = await this.installTree(h, p.app, p.tree, p.version);
      this.say(`${h}: ${p.app} updated to ${p.version} (from ${have.version ?? "none"}; ${n} messages as root)`);
    }
  }

  /** Start (publish) an instance: the instance manager's start, reused (routed by `topics`). */
  private async start(handle: string, topics: string[]): Promise<void> {
    await this.internals.manage.call(this.r, "start", { handle, topics });
  }

  /** Stop an instance: the instance manager's stop, reused (disabled, its kernel stopped, off its libp2p node). */
  private async stop(handle: string): Promise<void> {
    await this.internals.manage.call(this.r, "stop", { handle });
  }

  /** Whether the token instance holds its token (amm/token): GET /amm/token answers. */
  private async hasToken(id: string): Promise<boolean> {
    const l = await this.r.hydrate(id);
    return (await l.kernel.call("head", "amm/token")) != null;
  }

  /**
   * The deploy fed in: the event {kind: "deploy", beef} in amm/deploy, through the door (its BUMPs
   * checked against the host chain, which the instance is sent first). true: admitted.
   */
  private async feedDeploy(id: string, beef: Uint8Array): Promise<boolean> {
    const { DoorAnswered } = this.o.sk.door;
    for (let attempt = 1; ; attempt++) {
      // The door checks the BUMPs against chain/state: the host chain's event taken first (as a create's BEEF delivery waits for it).
      await this.internals.chainBirth.call(this.r, id).catch(() => {});
      await this.internals.queues.get(id);
      await this.r.loaded.get(id)?.kernel.idle().catch(() => {});
      try {
        const e = await this.r.admitEvent(id, "amm/deploy", { kind: "deploy", beef });
        await this.internals.queues.get(id);
        await this.r.loaded.get(id)?.kernel.idle().catch(() => {});
        this.say(`${id}: its deploy admitted (event ${e.toString().slice(-8)} in amm/deploy)${(await this.hasToken(id)) ? ", amm/token written" : ", but no amm/token (its log says why)"}`);
        return true;
      } catch (x) {
        const why = x instanceof DoorAnswered ? x.answer.reason ?? String(x.answer.status) : (x as Error).message;
        // The host chain's start event may still be on its way (it is sent, not awaited, at a start): once more.
        if (attempt < 3 && /chain|header|bump|merkle|root/i.test(why)) { this.say(`${id}: its deploy refused (${why}): once more after the host chain`); await new Promise((r) => setTimeout(r, 1000 * attempt)); continue; }
        this.say(`${id}: its deploy refused at the door: ${why}`);
        return false;
      }
    }
  }

  /** The defaults the event carried, to a new instance: root's messages (signed by the host's key), `terms` into amm/validator, `market` into amm/amm-p2p. */
  private async terms(id: string, rec: Rec): Promise<void> {
    const terms = rec.terms as Terms | undefined, market = rec.market as Market | undefined;
    if (terms && typeof terms === "object") await this.sendTerms(id, terms);
    if (market && typeof market === "object") await this.rootMessage(id, "amm/amm-p2p", { fn: "market", args: market }).then(() => this.say(`${id}: market minimum ${market.minCommissionBps} sent`), (e) => this.say(`${id}: market not taken: ${(e as Error).message}`));
  }

  /** Root's `terms` (a map, or null = market only) into the token instance's amm/validator, signed by the host's key; logged. */
  private async sendTerms(id: string, terms: Terms | null): Promise<void> {
    await this.rootMessage(id, "amm/validator", { fn: "terms", args: terms }).then(() => this.say(`${id}: terms ${terms ? `${terms.lpFeeBps}/${terms.validatorFeeBps}/${terms.commissionBps}${terms.minLegSats ? ` minimum leg ${terms.minLegSats} sats` : ""}` : "null (market only)"} sent`), (e) => this.say(`${id}: terms not taken: ${(e as Error).message}`));
  }

  /** Root's message to `handle` in `box`, signed by the host's key, through the front door (the control socket's `message` path); throws on a refusal. */
  async rootMessage(handle: string, box: string, body: Rec): Promise<void> {
    const recipient = this.r.o.db.get(handle)?.identity;
    if (!recipient) throw new Error(`no instance ${handle}`);
    const m = await this.o.sk.raw.signMessage(this.o.hostWallet, { recipient, box, body: this.o.sk.cid.encode(body).bytes });
    await this.r.messageLocal(handle, this.o.sk.cid.encode(m.message).bytes, m.body);
  }

  // ---------------------------------------------------------------- reconcile

  /** A read of swap's (GET /@swap/amm/<path>), in process. */
  private async swapRead(path: string): Promise<unknown> {
    const r = await this.r.dispatch({ method: "GET", url: `${this.r.origin()}/@${SWAP}/${SWAP_APP}/${path}`, headers: {}, body: new Uint8Array() });
    if (r.status !== 200) throw new Error(`GET /@${SWAP}/${SWAP_APP}/${path}: ${r.status}`);
    return JSON.parse(new TextDecoder().decode(r.body));
  }

  /**
   * At start: the instance table rebuilt from swap's heads — /amm/tokens (enabled → running, its
   * deploy fed if it has no instance yet: the BEEF from swap's last token-enabled event for it, read
   * from swap's log; disabled → stopped) and /amm/discovery (on → running, else stopped). Creates
   * nothing that exists; queued like the events.
   */
  reconcile(): Promise<void> {
    return this.enqueue("reconcile", async () => {
      const swap = this.r.o.db.get(SWAP);
      if (!swap || swap.status !== "enabled") { this.say(`reconcile: no enabled instance ${SWAP} (the first run makes it): nothing to reconcile`); return; }
      const tokens = await this.swapRead("tokens") as Array<{ tokenId?: string; status?: string }>;
      let events: Map<string, Rec> | undefined;
      for (const t of tokens) {
        const id = t.tokenId ?? "";
        if (!TOKEN_ID.test(id)) continue;
        const row = this.r.o.db.get(id);
        if (t.status === "enabled") {
          if (row && row.status === "enabled" && await this.hasToken(id)) continue;
          events ??= await this.enabledEvents();
          const ev = events.get(id);
          await this.tokenEnabled({ ...(ev ?? {}), tokenId: id }).catch((e) => this.say(`reconcile ${id}: ${(e as Error).message}`));
        } else if (t.status === "disabled" && row?.status === "enabled") {
          await this.tokenDisabled({ tokenId: id });
        }
      }
      const d = await this.swapRead("discovery") as { on?: boolean };
      await this.discovery(d.on === true);
      // swap's claimant holds amm.admin (the grant may have been lost between the claim and the reaction).
      const adm = await this.swapRead("admin").catch(() => ({})) as { claimant?: string };
      if (adm.claimant) await this.claimed({ claimant: adm.claimant });
      this.say(`reconcile: ${tokens.filter((t) => t.status === "enabled").length} enabled, ${tokens.filter((t) => t.status === "disabled").length} disabled on swap; discovery ${d.on ? "on" : "off"}`);
    });
  }

  // A token-terms event is not replayed here: the token instance keeps its own amm/terms across restarts.

  /** swap's last token-enabled event per token id, from its log (the host recovers by reading the log, docs/VM.md "Events are open"). */
  private async enabledEvents(): Promise<Map<string, Rec>> {
    const row = this.r.o.db.get(SWAP)!;
    const st = this.o.sk.stores.openStoreFile(this.o.sk.indexStore.storeSpec(row), { readOnly: true });
    try {
      const found = await this.o.sk.p2p.emittedEvents(st, (rec) => rec.app === SWAP_APP && rec.event === "token-enabled" && typeof rec.tokenId === "string" ? rec : undefined);
      const out = new Map<string, Rec>();
      for (const r of found) out.set(r.tokenId as string, r); // log order: the last wins
      return out;
    } finally { st.close(); }
  }
}
