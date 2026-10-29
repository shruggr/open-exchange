// The skein host as a library (shruggr/skein#164): Open Exchange runs on skein's host, imported from a
// skein checkout's TypeScript sources the way skein's own bins run them (`node
// --experimental-strip-types`). Node strips no types under node_modules, so skein is not an npm
// dependency here: it is the checkout at SKEIN_DIR (default: the `skein` directory beside this
// repository), at or after the commit package.json names (`skein.commit`). Its own node_modules
// serve its imports.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** This repository's root. */
export const OX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The skein checkout the host runs on. */
export const SKEIN_DIR = resolve(process.env.SKEIN_DIR || join(OX_ROOT, "..", "skein"));
/** The images Open Exchange creates its instances from (swap, token, discovery). */
export const IMAGES_DIR = join(OX_ROOT, "image");

/** A module of the skein checkout, by its path there (`src/host/cli.ts`). */
export async function skein<T>(rel: string): Promise<T> {
  const p = join(SKEIN_DIR, rel);
  if (!existsSync(p)) throw new Error(`no skein checkout at ${SKEIN_DIR} (${rel} missing): set SKEIN_DIR to a shruggr/skein checkout`);
  return await import(pathToFileURL(p).href) as T;
}

/** The skein commit this repository needs (package.json `skein.commit`), and whether the checkout has it. */
export function skeinPin(): { commit: string; ok: boolean | undefined; head?: string } {
  const pkg = JSON.parse(readFileSync(join(OX_ROOT, "package.json"), "utf8")) as { skein?: { commit?: string } };
  const commit = pkg.skein?.commit ?? "";
  try {
    const head = execFileSync("git", ["-C", SKEIN_DIR, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", SKEIN_DIR, "merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" });
    return { commit, ok: true, head };
  } catch (e) {
    return { commit, ok: (e as { status?: number }).status === 1 ? false : undefined };
  }
}

export type Cli = typeof import("../../skein/src/host/cli.ts");
export type RouterMod = typeof import("../../skein/src/host/router.ts");
export type Router = import("../../skein/src/host/router.ts").Router;
export type HostDb = import("../../skein/src/host/instances.ts").HostDb;
export type InstancesMod = typeof import("../../skein/src/host/instances.ts");
export type HostEnvMod = typeof import("../../skein/src/host/hostenv.ts");
export type SignerMod = typeof import("../../skein/src/host/signer.ts");
export type RawMod = typeof import("../../skein/src/client/raw.ts");
export type CidMod = typeof import("../../skein/src/runtime/cid.ts");
export type DoorMod = typeof import("../../skein/src/host/door-answer.ts");
export type StoresMod = typeof import("../../skein/src/host/stores.ts");
export type IndexStoreMod = typeof import("../../skein/src/runtime/index-store.ts");
export type P2PMod = typeof import("../../skein/src/host/p2p.ts");
export type ControlMod = typeof import("../../skein/src/host/control.ts");

/** The skein modules the host uses, loaded once. */
export async function load() {
  const [cli, routerMod, instances, hostenv, signer, raw, cid, door, stores, indexStore, p2p, control] = await Promise.all([
    skein<Cli>("src/host/cli.ts"), skein<RouterMod>("src/host/router.ts"), skein<InstancesMod>("src/host/instances.ts"),
    skein<HostEnvMod>("src/host/hostenv.ts"), skein<SignerMod>("src/host/signer.ts"), skein<RawMod>("src/client/raw.ts"),
    skein<CidMod>("src/runtime/cid.ts"), skein<DoorMod>("src/host/door-answer.ts"), skein<StoresMod>("src/host/stores.ts"),
    skein<IndexStoreMod>("src/runtime/index-store.ts"), skein<P2PMod>("src/host/p2p.ts"), skein<ControlMod>("src/host/control.ts"),
  ]);
  return { cli, routerMod, instances, hostenv, signer, raw, cid, door, stores, indexStore, p2p, control };
}
export type Skein = Awaited<ReturnType<typeof load>>;
