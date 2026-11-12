// The pool feeds (`/amm/events`, `/@<token>/amm/events`): written to a real HTTP connection the way skein's Router
// writes an appRead stream (headers, flushHeaders, each chunk), a feed sends an SSE comment at once, with no event,
// and a keep-alive comment on its interval; the connection closing clears the timer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Pools } from "./pools.ts";

type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;

test("a feed sends a comment at once and a keep-alive on its interval", async () => {
  const was = Pools.KEEPALIVE_MS;
  Pools.KEEPALIVE_MS = 200;
  const pools = new Pools({} as never, () => {}, () => null, {} as never);
  const subs = new Set<(chunk: string) => void>();
  let closed!: () => void;
  const forgotten = new Promise<void>((ok) => { closed = ok; });
  const server = createServer((_req, res) => {
    const r = pools["feed"](subs) as RouterResponse;
    res.writeHead(r.status, { "access-control-allow-origin": "*", ...r.headers });
    res.flushHeaders();
    const forget = r.stream!((chunk) => res.write(chunk), () => res.end());
    res.on("close", () => { forget(); closed(); });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const ac = new AbortController();
  try {
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/amm/events`, { signal: ac.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = dec.decode((await reader.read()).value);
    assert.equal(text, ": connected\n\n");
    assert.ok(Date.now() - t0 < 150, "the first bytes come before any keep-alive");
    while (!text.includes(": keep-alive\n\n")) text += dec.decode((await reader.read()).value);
    ac.abort();
    await forgotten;
  } finally {
    Pools.KEEPALIVE_MS = was;
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
  assert.equal(subs.size, 0);
  assert.equal(pools["ends"].size, 0);
});
