// The host's reads of an instance's event index (0.21.0; skein >= 0.5.0, src/host/events.ts): the Router's public
// `events` registry — `read(handle, query)` once, `subscribe(handle, query, send, close)` the same read then each new
// matching event as its step's commit hands it over. Records come as DAG-JSON text; `record` turns one into a value
// (bytes → Uint8Array, a link → its CID text, an integer past 2^53 → bigint).
import type { Router } from "./skein.ts";

type RouterEvents = Router["events"];
export type EventsQuery = Parameters<RouterEvents["read"]>[1];
export type Delivered = Awaited<ReturnType<RouterEvents["read"]>>[number];
export type Rec = Record<string, unknown>;

/** A delivered event's record as a value. */
export function record(d: Delivered): Rec {
  const v = JSON.parse(d.data, (_k, x: unknown, ctx?: { source?: string }) => {
    if (typeof x === "number" && Number.isInteger(x) && !Number.isSafeInteger(x) && ctx?.source && /^-?\d+$/.test(ctx.source)) return BigInt(ctx.source);
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const o = x as Rec;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === "/") {
        const s = o["/"];
        if (typeof s === "string") return s; // a link: its CID text
        if (s && typeof s === "object" && typeof (s as Rec).bytes === "string") return Uint8Array.from(Buffer.from((s as Rec).bytes as string, "base64"));
      }
    }
    return x;
  }) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? v as Rec : {};
}

/**
 * Follow `query` on `handle` from NOW: the events already in the index are read once and skipped; each later one is
 * handed to `on` (its name, its record), in log order. Returns the function that stops it. `closed` runs when the host
 * ends the stream (the instance stopped).
 */
export async function followNew(router: Router, handle: string, query: EventsQuery, on: (name: string, rec: Rec, d: Delivered) => void, closed?: () => void): Promise<() => void> {
  const seen = new Set((await router.events.read(handle, query)).map((d) => d.id));
  return await router.events.subscribe(handle, query, (d) => { if (!seen.has(d.id)) on(d.event, record(d), d); }, () => closed?.());
}

/** Follow `query` on `handle` from the start of its index (a fold: replayed, then live). Resolves once the replay is handed over. */
export async function followAll(router: Router, handle: string, query: EventsQuery, on: (name: string, rec: Rec, d: Delivered) => void, closed?: () => void): Promise<() => void> {
  return await router.events.subscribe(handle, query, (d) => on(d.event, record(d), d), () => closed?.());
}

/** The latest event under exactly `name` on `handle`, its record, or undefined. */
export async function latest(router: Router, handle: string, name: string): Promise<Rec | undefined> {
  const rows = await router.events.read(handle, { name, latest: true });
  const d = rows[rows.length - 1];
  return d ? record(d) : undefined;
}
