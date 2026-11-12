// The door's X-Topics parse: a JSON array or a comma-separated list (as the skein router reads it), against a stub
// host whose instance serves tm_color/ls_color; the submit itself is stubbed to record the topic it was handed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Door, type Verdict } from "./door.ts";

const HANDLE = "discovery";

class Probe extends Door {
  calls: string[] = [];
  override async submit(_handle: string, _beef: Uint8Array, topic: string): Promise<Verdict> {
    this.calls.push(topic);
    return { verdict: "admitted", steak: { [topic]: { outputsToAdmit: [0], coinsToRetain: [] } } };
  }
}

function door(): Probe {
  const router = { o: { db: { get: (h: string) => (h === HANDLE ? { topics: JSON.stringify(["tm_color", "ls_color"]) } : undefined) } } };
  return new Probe(router as never, () => {});
}

async function post(d: Probe, xTopics?: string) {
  const headers: Record<string, string> = {};
  if (xTopics !== undefined) headers["x-topics"] = xTopics;
  const res = await d.route(HANDLE, "/submit", { method: "POST", headers, body: new Uint8Array() } as never);
  assert.ok(res);
  return { status: res.status, body: JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown> };
}

test("JSON form accepted", async () => {
  const d = door();
  const r = await post(d, '["tm_color"]');
  assert.equal(r.status, 200);
  assert.deepEqual(d.calls, ["tm_color"]);
});

test("comma form, single topic: the same path as the JSON form", async () => {
  const d = door();
  const r = await post(d, "tm_color");
  assert.equal(r.status, 200);
  assert.deepEqual(d.calls, ["tm_color"]);
  assert.deepEqual(r.body, (await post(door(), '["tm_color"]')).body);
});

test("comma form with spaces", async () => {
  const d = door();
  const r = await post(d, " tm_color , ls_color ,");
  assert.equal(r.status, 200);
  assert.deepEqual(d.calls, ["tm_color"]);
});

test("empty or absent header: 400", async () => {
  for (const h of [undefined, "", "  ", ",, ,"]) {
    const d = door();
    const r = await post(d, h);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "ERR_BAD_REQUEST");
    assert.equal(d.calls.length, 0);
  }
});

test("JSON not a non-empty array of strings: 400", async () => {
  for (const h of ["[]", "[1]", "[tm_color"]) {
    const d = door();
    const r = await post(d, h);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "ERR_BAD_REQUEST");
    assert.equal(d.calls.length, 0);
  }
});

test("a topic not served: 400 ERR_UNSUPPORTED_TOPIC in both forms", async () => {
  for (const h of ['["tm_color","tm_other"]', "tm_color,tm_other"]) {
    const d = door();
    const r = await post(d, h);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "ERR_UNSUPPORTED_TOPIC");
    assert.equal(d.calls.length, 0);
  }
});
