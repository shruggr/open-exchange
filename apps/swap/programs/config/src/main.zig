//! The swap app's program `config` (Open Exchange, shruggr/open-exchange#1; skein-amm's amm-config
//! 0.22.0 moved here and CHANGED, shruggr/skein#164): root's decisions recorded as facts under the
//! app's own heads and emitted as events the Open Exchange host reacts to. Nothing is asked of
//! anyone and nothing answers back: no instance manager, no creating/failed states. The decisions
//! are tokens.zig's and discovery.zig's; this file wires them to the VM.
//!
//! **Stepped** (mailbox routes):
//!
//!   box `amm/admin` (kernel.beef; its route's function `configure` gated by the role admin, granted
//!   as `amm.admin` — root passes anything, so the host's key can too; 0.5.0):
//!     {fn: "enable", args: {tokenId, beef?}}   the BEEF (the door checked it and handed the
//!                       envelope; the wire read back, chain.record.wireOf) must be the token id's
//!                       deploy (tokens.zig `deployOf`); `beef` may be left out for a token already
//!                       on the list (its kept `deploy`). The row `enabled` (since now, the BEEF kept
//!                       as `deploy`) and the event `amm/token/<tokenId>` (0.21.0) `{state: "enabled", tokenId, beef,
//!                       terms?, market?}` (the defaults at this step). An enabled token enabled again: the
//!                       same fact again (the host's reaction is idempotent).
//!     {fn: "disable", args: {tokenId}}   a token on the list: the row `disabled`, the event
//!                       `amm/token/<tokenId>` `{state: "disabled", tokenId}`.
//!     {fn: "terms", args: {tokenId, terms}}   a token on the list (enabled or disabled); `terms`
//!                       `{lpFeeBps, validatorFeeBps, commissionBps, minLegSats?}` (checked as the defaults' are)
//!                       or null (market only): the event `amm/token-terms/<tokenId>` `{tokenId, terms}`
//!                       (the host sends it to the token instance as root's `terms`); nothing kept
//!                       here: the token instance's `amm/terms` is the record (0.12.0).
//!     {fn: "defaults", args: {terms?, market?}}   the head `amm/defaults` (tokens.zig `withDefaults`).
//!     {fn: "discovery", args: {on}}   the head `amm/discovery` `{on, since}` and the event
//!                       `amm/discovery` `{on}` (discovery.zig).
//!     {fn: "price", args: {sats | null}}   (0.15.0) the price to enable a token: the head
//!                       `amm/enable-price` (null: off); `enable-check` reads it (0.15.3: no event) (paid.zig).
//!     (0.21.0: no `withdraw` — no collecting in this rebuild, HANDOFF-2026-11-09 WALLET + SIGNER
//!                       "SCOPE": refused as an unknown fn.)
//!   box `amm/claim` (kernel.beef; its function `claim` gated by no role: any sender; claim.zig):
//!     {fn: "claim"}   the first: the head `amm/claim` `{claimant: <the sender>, since}` and the
//!                       event `amm/claim` `{claimant: <hex>}` (the host grants it amm.admin);
//!                       answered `{fn: "claim", result: {claimant: <hex>}}`. A later one: refused
//!                       (`claimed`), nothing written, no event.
//!     Each answered to the sender in that box: `{fn, request, replyTo, result | error}`. A body
//!     that is itself an answer (`request` / `replyTo` in it: this program's answer looped back
//!     when root's key is the instance's own, a one-key host) is not a request: nothing runs.
//!
//! **Called** (read routes; their filters: anyone, nothing logged):
//!
//!   tokens    `/tokens`: the enable list, newest first (tokens.zig `tokensJson`)
//!   defaults  `/defaults`: the defaults, `{terms?, market?, enablePriceSats}` (tokens.zig `defaultsJson`)
//!   discovery `/discovery`: `{on, since}`, or `{on: false}` (discovery.zig `json`)
//!   admin     `/admin`: `{claimant, since}`, or `{}` unclaimed (claim.zig `json`)
//!   serve     `/` (prefix): the Swap pages, www/ of the app's own tree (skein-sdk `files.serve`)
//!
//! **The paid enable** (0.15.3; paid.zig): `POST /enable?tokenId=&paymentTxid=&paymentVout=&derivationPrefix=
//! &derivationSuffix=`, the body ONE BEEF with the token's deploy and the payment; filters kernel.brc104,
//! kernel.beef, then this app's `enable-check` (fn `enableCheck`); the handler `enablePaid`, in the request's step
//! (PREPARED, rebuild-0.21-perms; HANDOFF-2026-11-09 WALLET + SIGNER and its CORRECTION): (1) the payee key, BRC-29
//! for the signed sender, from the SIGNER APP under any name (manifest `calls: {signer: "*"}`); (2) the payment
//! output must pay it; (3) the payment's own BEEF (cut, parents first) into the CHAIN APP by its in-VM `ingest`
//! (it records it and emits the broadcast); (4) filed with the WALLET APP, `callAs(file, "bsv", {outpoint,
//! protocol: [2, "3241645161d8"], keyID: "<prefix> <suffix>", counterparty: <the sender>})` (manifest `calls:
//! {wallet: ["bsv"]}`); (5) what the admin's enable does, keeping `{paidBy, paymentTxid, satoshisPaid}`. A payment a
//! row of this app keeps already: refused (409). No `amm/pay` box, no genesis wallet.
const std = @import("std");
const w = @import("chain");
const vm = @import("overlay_sk");
const tokens = @import("tokens.zig");
const discovery = @import("discovery.zig");
const claim = @import("claim.zig");
const paid = @import("paid.zig");
const wl = @import("wallet");
const ssk = @import("sk");
const app = @import("app");
const files = @import("files");
const scbor = @import("sdk_cbor");
const signer = @import("signer");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const app_name = "amm";
const app_head = "amm/app";

pub fn main() u8 {
    return vm.main("config", run);
}

fn run(a: Allocator) anyerror!void {
    const in = try vm.input(a);
    if (eql(u8, in.getText("kind") orelse "", "call")) return call(a, in);
    return step(a, in);
}

// ---------------------------------------------------------------- reads

fn isFilter(in: Value) bool {
    const f = in.get("filter") orelse return false;
    return f == .boolean and f.boolean;
}

fn asFilterAnswer(a: Allocator, http: Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "answer", .value = http }}) };
}

fn httpJson(a: Allocator, status: u16, body: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "status", .value = .{ .uint = status } },
        .{ .key = "type", .value = .{ .text = "application/json" } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}

fn headRecord(a: Allocator, name: []const u8) !?Value {
    const c = (try vm.head(a, name)) orelse return null;
    return try vm.store().getValue(a, c);
}

fn call(a: Allocator, in: Value) !void {
    const func = in.getText("fn") orelse return error.BadInput;
    const arg = try vm.callArg(a, in);
    const ans: Value = if (eql(u8, func, "tokens"))
        try httpJson(a, 200, try tokens.tokensJson(a, tokens.rowsOf(try headRecord(a, tokens.tokens_head))))
    else if (eql(u8, func, "defaults"))
        try httpJson(a, 200, try tokens.defaultsJson(a, try headRecord(a, tokens.defaults_head), paid.priceOf(try headRecord(a, paid.price_head))))
    else if (eql(u8, func, "discovery"))
        try httpJson(a, 200, try discovery.json(a, try headRecord(a, discovery.head)))
    else if (eql(u8, func, "admin"))
        try httpJson(a, 200, try claim.json(a, try headRecord(a, claim.head)))
    else if (eql(u8, func, "serve"))
        try servePages(a, arg)
    else if (eql(u8, func, "enableCheck"))
        return vm.answer(a, try enableCheck(a, arg))
    else if (eql(u8, func, "enablePaid"))
        return vm.answer(a, try enablePaid(a, in, arg))
    else
        return error.UnknownFunction;
    return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, ans) else ans);
}

/// The request body's BEEF as the door handed it (its envelope: the wire bytes back), or null: no BEEF.
fn bodyWire(a: Allocator, arg: Value) ?[]const u8 {
    const env = arg.get("body") orelse return null;
    if (env != .map) return null;
    return w.record.wireOf(a, vm.store(), env) catch null;
}

/// PREPARED (rebuild-0.21-perms): whether a payment was used for a listing already — a row of this app's own list
/// keeps it (`paymentTxid`). (Was: the genesis wallet's `wallet/state` actions; the genesis wallet goes.)
fn paymentUsed(a: Allocator, txid: [32]u8) !bool {
    const hex = std.fmt.bytesToHex(txid, .lower);
    for (tokens.rowsOf(try headRecord(a, tokens.tokens_head))) |r| if (eql(u8, r.getText("paymentTxid") orelse "", &hex)) return true;
    return false;
}

/// The wallet app's basket the listing payments are filed in (the instance's ONE BSV basket, HANDOFF-2026-11-09
/// "BASKETS PER INSTANCE"); the manifest's `calls: {wallet: ["bsv"]}` is its approval.
pub const bsv_basket = "bsv";

/// An installed app's program by its app record (head `<name>/app`, `programs.<prog>`), or null.
fn appProgram(a: Allocator, name: []const u8, prog: []const u8) !?[]const u8 {
    const rec = (try headRecord(a, try std.fmt.allocPrint(a, "{s}/app", .{name}))) orelse return null;
    const ps = rec.get("programs") orelse return null;
    return ps.getCid(prog);
}

/// The kernel's name-carrying in-VM call (skein `call-permissions`; kernel-permissions-contract §1): the kernel checks
/// this app is approved to call the callee under `name`. A re-pin to `sk.callAs` when the SDK carries it.
const named = struct {
    extern "skein" fn callAs(prog: [*]const u8, prog_len: u32, func: [*]const u8, func_len: u32, name: [*]const u8, name_len: u32, arg: [*]const u8, arg_len: u32, out: [*]u8, cap: u32) i32;
};
fn callAs(a: Allocator, prog: []const u8, func: []const u8, name: []const u8, arg: []const u8) ![]u8 {
    return ssk.result(a, named.callAs, .{ prog.ptr, @as(u32, @intCast(prog.len)), func.ptr, @as(u32, @intCast(func.len)), name.ptr, @as(u32, @intCast(name.len)), arg.ptr, @as(u32, @intCast(arg.len)) });
}

fn problemJson(a: Allocator, status: u16, code: []const u8, description: []const u8) !Value {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.write(.{ .status = "error", .code = code, .description = description });
    return httpJson(a, status, out.written());
}

/// The filter `enable-check` (0.15.3): the paid enable's refusals, before anything is recorded (paid.zig `check`).
fn enableCheck(a: Allocator, arg: Value) !Value {
    const query = arg.getText("query") orelse "";
    const held = if (try paid.queryPayment(a, query)) |n| try paymentUsed(a, n.txid) else false;
    return switch (try paid.check(a, paid.priceOf(try headRecord(a, paid.price_head)), tokens.rowsOf(try headRecord(a, tokens.tokens_head)), query, bodyWire(a, arg), held)) {
        .refused => |r| try paid.rejectAnswer(a, r),
        .ok => try paid.passAnswer(a),
    };
}

/// The handler `enablePaid` (0.15.3): the payment's output must pay the BRC-29 key derived for the signed sender
/// (key id "<prefix> <suffix>", counterparty the sender, for self) — else 400, nothing enabled; then the payment into
/// the chain app and filed with the wallet app (PREPARED), and the admin's enable: the row with the payment,
/// the event token-enabled with the defaults (its BEEF the deploy's, Atomic); answered `{fn: "enable", result: <the row>}`.
fn enablePaid(a: Allocator, in: Value, arg: Value) !Value {
    const query = arg.getText("query") orelse "";
    const wire = bodyWire(a, arg) orelse return problemJson(a, 400, "ERR_BAD_DEPLOY", "want the body: one BEEF holding the token's deploy and the payment");
    const rows = tokens.rowsOf(try headRecord(a, tokens.tokens_head));
    const held = if (try paid.queryPayment(a, query)) |n| try paymentUsed(a, n.txid) else false;
    const ok = switch (try paid.check(a, paid.priceOf(try headRecord(a, paid.price_head)), rows, query, wire, held)) {
        .refused => |r| return problemJson(a, r.status, r.code, r.reason),
        .ok => |x| x,
    };
    const sender = arg.getBytes("caller") orelse return problemJson(a, 401, "ERR_UNAUTHORIZED", "a paid enable is signed: its sender is the payer");
    if (sender.len != 33) return problemJson(a, 401, "ERR_UNAUTHORIZED", "the sender is not an identity key");
    const np = ok.payment;
    const out = (try paid.outputIn(a, wire, np.txid, np.vout)).?;
    // 1. The key this payment must pay: BRC-29, the standard way (counterparty the sender, for self), from the SIGNER
    //    APP under any name (the payer is anyone: the swap app's approval is `calls: {signer: "*"}`, root's grant).
    const frame = try wl.wire.getPublicKeyFrameFor(a, wl.brc29.security_level, wl.brc29.protocol_name, try wl.brc29.keyId(a, np.prefix, np.suffix), .{ .other = sender[0..33].* }, true);
    const key = try wl.wire.publicKeyResult(try signer.requestAny(a, frame));
    // 2. The output pays it.
    if (!eql(u8, out.script, &wl.brc29.p2pkh(key))) return problemJson(a, 400, "ERR_INVALID_PAYMENT", "the payment output does not pay this exchange's BRC-29 key for the sender and the named derivation");
    const sender_hex = try a.dupe(u8, &std.fmt.bytesToHex(sender[0..33].*, .lower));
    // 3. The payment into the chain app, in this step (chain 0.10.0 `ingest` as an in-VM call: it records it and emits
    //    the broadcast; the payer paid BRC-177 nosend, so nobody else sends it). Its own BEEF, cut parents first.
    const chain_prog = (try appProgram(a, "chain", "chain")) orelse return problemJson(a, 503, "ERR_UNAVAILABLE", "no chain app is installed (no head chain/app)");
    _ = try ssk.call(a, chain_prog, "ingest", try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "beef", .value = .{ .bytes = try paid.cutFor(a, wire, np.txid) } }}) }));
    // 4. Filed with the wallet app as ours, under the BSV basket, with the payer's BRC-29 derivation (HANDOFF-2026-11-09
    //    WALLET + SIGNER point 9 and its CORRECTION: "listing payment → filed as ours with the payer's derivation").
    const wallet_prog = (try appProgram(a, "wallet", "wallet")) orelse return problemJson(a, 503, "ERR_UNAVAILABLE", "no wallet app is installed (no head wallet/app)");
    const outpoint = try std.fmt.allocPrint(a, "{s}.{d}", .{ np.txid_hex, np.vout });
    _ = try callAs(a, wallet_prog, "file", bsv_basket, try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "outpoint", .value = .{ .text = outpoint } },
        .{ .key = "protocol", .value = .{ .array = try a.dupe(Value, &.{ .{ .uint = wl.brc29.security_level }, .{ .text = wl.brc29.protocol_name } }) } },
        .{ .key = "keyID", .value = .{ .text = try wl.brc29.keyId(a, np.prefix, np.suffix) } },
        .{ .key = "counterparty", .value = .{ .text = sender_hex } },
    }) }));
    // 5. The admin's enable, the payment kept on the row.
    const row = try paid.paidRow(a, try tokens.enabledRow(a, ok.deploy, now(in), .{ .bytes = ok.deploy_beef }), sender, np.txid_hex, out.satoshis);
    try saveRow(a, row);
    _ = try vm.emitEvent(a, try tokens.enabledEvent(a, ok.deploy.token_id, ok.deploy_beef, try headRecord(a, tokens.defaults_head)));
    var o: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &o.writer };
    try jw.beginObject();
    try jw.objectField("fn");
    try jw.write("enable");
    try jw.objectField("result");
    try tokens.writeJson(&jw, try tokens.shown(a, row));
    try jw.endObject();
    return httpJson(a, 200, o.written());
}

fn toSdk(a: Allocator, v: Value) !scbor.Value {
    return scbor.decode(a, try cbor.encode(a, v));
}

fn fromSdk(a: Allocator, v: scbor.Value) !Value {
    return cbor.decode(a, try scbor.encode(a, v));
}

/// The read `/`: the pages from the app's own tree (the installed app record's `tree`).
fn servePages(a: Allocator, arg: Value) !Value {
    const req = try toSdk(a, arg);
    const m = try app.manifestOf(a, app_name);
    return fromSdk(a, try files.serve(a, req, scbor.Value.cidOf(m.get("tree")), files.rowOptions(req)));
}

// ---------------------------------------------------------------- steps

fn resultRecord(a: Allocator, op: []const u8, fields: []const cbor.Entry) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "amm-config-result" } },
        .{ .key = "op", .value = .{ .text = op } },
    });
    try es.appendSlice(a, fields);
    return .{ .map = es.items };
}

fn step(a: Allocator, in: Value) !void {
    const s = vm.store();
    const args = in.get("args") orelse return error.BadInput;
    const box = args.getText("box") orelse "";
    const body = try s.getValue(a, args.getCid("body") orelse return error.BadInput);
    const is_claim = eql(u8, box, claim.box);
    if (!is_claim and !eql(u8, box, tokens.admin_box)) return error.BadInput;
    if (tokens.isAnswer(body)) {
        _ = try vm.finish(a, s, try resultRecord(a, "answer", &.{}));
        return;
    }
    const func = body.getText("fn") orelse "";
    if (is_claim) {
        if (eql(u8, func, "claim")) return claimSet(a, in, args);
        return answerRoot(a, args, func, try tokens.refusal(a, func, args.getCid("message"), "unknown-fn", "amm/claim takes claim"));
    }
    if (eql(u8, func, "enable")) return enable(a, in, args, body);
    if (eql(u8, func, "disable")) return disable(a, in, args, body);
    if (eql(u8, func, "terms")) return termsSet(a, args, body);
    if (eql(u8, func, "defaults")) return defaults(a, args, body);
    if (eql(u8, func, "discovery")) return discoverySet(a, in, args, body);
    if (eql(u8, func, "price")) return priceSet(a, args, body);
    return answerRoot(a, args, func, try tokens.refusal(a, func, args.getCid("message"), "unknown-fn", "amm/admin takes enable, disable, terms, defaults, discovery and price"));
}

/// Answer the message's sender in the box it wrote to; the thread ends.
fn answerRoot(a: Allocator, args: Value, op: []const u8, answer: Value) !void {
    if (answer.get("error")) |e| std.log.err("{s}: refused: {s}", .{ op, e.getText("message") orelse "" });
    if (args.getBytes("sender")) |sender| {
        _ = vm.send(a, sender, args.getText("box") orelse tokens.admin_box, answer) catch |e| std.log.err("{s}: the answer is not sent: {s}", .{ op, @errorName(e) });
    }
    _ = try vm.finish(a, vm.store(), try resultRecord(a, op, &.{.{ .key = "answer", .value = answer }}));
}

fn saveRow(a: Allocator, row: Value) !void {
    const s = vm.store();
    const rec = try tokens.withRow(a, tokens.rowsOf(try headRecord(a, tokens.tokens_head)), row);
    try vm.advance(tokens.tokens_head, try s.putValue(a, rec));
}

fn tokenIdArg(a: Allocator, body: Value) !?[]const u8 {
    const fargs = body.get("args") orelse return null;
    return tokens.canonicalId(a, fargs.getText("tokenId") orelse return null);
}

fn now(in: Value) u64 {
    return in.getUint("at") orelse in.getUint("now") orelse 0;
}

/// `enable {tokenId, beef?}`.
fn enable(a: Allocator, in: Value, args: Value, body: Value) !void {
    const s = vm.store();
    const message = args.getCid("message");
    const id = (try tokenIdArg(a, body)) orelse return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", "want args {tokenId: <txid>_<vout>, beef}"));
    const prev = tokens.find(tokens.rowsOf(try headRecord(a, tokens.tokens_head)), id);
    const fargs = body.get("args").?;
    // The BEEF given, else the one kept on the token's row.
    const env: Value = fargs.get("beef") orelse (if (prev) |p| p.get("deploy") else null) orelse return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", "want args {tokenId, beef}: the deploy's Atomic BEEF"));
    // The door's envelope (shruggr/skein#146: its exact wire bytes back through `wireOf`), or the bytes.
    const wire: []const u8 = switch (env) {
        .bytes => |b| b,
        .map => w.record.wireOf(a, s, env) catch |e| return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", try std.fmt.allocPrint(a, "beef: not a BEEF the door read ({s})", .{@errorName(e)}))),
        else => return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", "beef: want the deploy's Atomic BEEF (bytes)")),
    };
    const d = switch (try tokens.deployOf(a, id, wire)) {
        .refused => |why| return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", why)),
        .ok => |x| x,
    };
    const row = try tokens.enabledRow(a, d, now(in), env);
    try saveRow(a, row);
    _ = try vm.emitEvent(a, try tokens.enabledEvent(a, d.token_id, wire, try headRecord(a, tokens.defaults_head)));
    return answerRoot(a, args, "enable", try tokens.answer(a, "enable", message, try tokens.shown(a, row)));
}

/// `disable {tokenId}`.
fn disable(a: Allocator, in: Value, args: Value, body: Value) !void {
    const message = args.getCid("message");
    const id = (try tokenIdArg(a, body)) orelse return answerRoot(a, args, "disable", try tokens.refusal(a, "disable", message, "bad-args", "want args {tokenId: <txid>_<vout>}"));
    const prev = tokens.find(tokens.rowsOf(try headRecord(a, tokens.tokens_head)), id) orelse return answerRoot(a, args, "disable", try tokens.refusal(a, "disable", message, "bad-args", try std.fmt.allocPrint(a, "{s} is not on the list", .{id})));
    const row = try tokens.updated(a, prev, .disabled, &.{.{ .key = "since", .value = .{ .uint = now(in) } }}, &.{});
    try saveRow(a, row);
    _ = try vm.emitEvent(a, try tokens.disabledEvent(a, id));
    return answerRoot(a, args, "disable", try tokens.answer(a, "disable", message, try tokens.shown(a, row)));
}

/// `terms {tokenId, terms}`: the event only.
fn termsSet(a: Allocator, args: Value, body: Value) !void {
    const message = args.getCid("message");
    switch (try tokens.termsChange(a, tokens.rowsOf(try headRecord(a, tokens.tokens_head)), body.get("args"))) {
        .bad => |why| return answerRoot(a, args, "terms", try tokens.refusal(a, "terms", message, "bad-args", why)),
        .ok => |c| {
            const ev = try tokens.termsEvent(a, c.token_id, c.terms);
            _ = try vm.emitEvent(a, ev);
            return answerRoot(a, args, "terms", try tokens.answer(a, "terms", message, ev));
        },
    }
}

/// `defaults {terms?, market?}`.
fn defaults(a: Allocator, args: Value, body: Value) !void {
    const s = vm.store();
    const message = args.getCid("message");
    switch (try tokens.withDefaults(a, try headRecord(a, tokens.defaults_head), body.get("args"))) {
        .bad => |why| return answerRoot(a, args, "defaults", try tokens.refusal(a, "defaults", message, "bad-args", why)),
        .ok => |rec| {
            try vm.advance(tokens.defaults_head, try s.putValue(a, rec));
            return answerRoot(a, args, "defaults", try tokens.answer(a, "defaults", message, rec));
        },
    }
}

/// `discovery {on}`: the record and the event.
fn discoverySet(a: Allocator, in: Value, args: Value, body: Value) !void {
    const message = args.getCid("message");
    const on = discovery.onArg(body.get("args")) orelse return answerRoot(a, args, "discovery", try tokens.refusal(a, "discovery", message, "bad-args", "want args {on: true | false}"));
    const rec = try discovery.record(a, on, now(in));
    try vm.advance(discovery.head, try vm.store().putValue(a, rec));
    _ = try vm.emitEvent(a, try discovery.event(a, on));
    return answerRoot(a, args, "discovery", try tokens.answer(a, "discovery", message, rec));
}

/// `price {sats | null}` (0.15.0; 0.15.3: the record only).
fn priceSet(a: Allocator, args: Value, body: Value) !void {
    const message = args.getCid("message");
    const sats = switch (paid.priceArg(body.get("args"))) {
        .bad => |why| return answerRoot(a, args, "price", try tokens.refusal(a, "price", message, "bad-args", why)),
        .ok => |n| n,
    };
    const rec = try paid.priceRecord(a, sats);
    try vm.advance(paid.price_head, try vm.store().putValue(a, rec));
    return answerRoot(a, args, "price", try tokens.answer(a, "price", message, rec));
}

/// `claim` (box amm/claim, any sender): the first claim recorded and emitted; a later one refused.
fn claimSet(a: Allocator, in: Value, args: Value) !void {
    const message = args.getCid("message");
    const sender = args.getBytes("sender") orelse return answerRoot(a, args, "claim", try tokens.refusal(a, "claim", message, "no-sender", "a claim is a signed message: its sender is the claimant"));
    if (claim.claimantOf(try headRecord(a, claim.head))) |held| {
        return answerRoot(a, args, "claim", try tokens.refusal(a, "claim", message, "claimed", try std.fmt.allocPrint(a, "this exchange is claimed: its admin is {s}", .{try claim.hex(a, held)})));
    }
    try vm.advance(claim.head, try vm.store().putValue(a, try claim.record(a, sender, now(in))));
    _ = try vm.emitEvent(a, try claim.event(a, sender));
    return answerRoot(a, args, "claim", try tokens.answer(a, "claim", message, try claim.result(a, sender)));
}
