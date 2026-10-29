//! The discovery switch (Open Exchange, shruggr/open-exchange#1; skein-amm 0.18.0's toggle, as a
//! fact), pure: main.zig wires the VM.
//!
//! - **The record**, the root of the head `amm/discovery`: `{kind: "amm-discovery", on, since}` —
//!   root's last decision (shruggr/skein#164: a fact; the host starts or stops the instance
//!   `discovery` it created at setup, serving the 1Color discovery topic `tm_color` and its lookup
//!   `ls_color`). No record: off (`{on: false}` read).
//! - **Root's message** `{fn: "discovery", args: {on: true|false}}` in the box `amm/admin`: the
//!   record written and the event `discovery-on` / `discovery-off` emitted (`event`), every time
//!   (the same decision again is the same fact again: the host's reaction is idempotent).
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const head = "amm/discovery";
pub const kind = "amm-discovery";

/// Root's `args` → `on`, or null (not `{on: true|false}`).
pub fn onArg(args: ?Value) ?bool {
    const x = args orelse return null;
    if (x != .map) return null;
    const v = x.get("on") orelse return null;
    return if (v == .boolean) v.boolean else null;
}

/// The record: `{kind, on, since}`.
pub fn record(a: Allocator, on: bool, at: u64) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = kind } },
        .{ .key = "on", .value = .{ .boolean = on } },
        .{ .key = "since", .value = .{ .uint = at } },
    }) };
}

/// The event: `{event: "discovery-on"}` or `{event: "discovery-off"}`.
pub fn event(a: Allocator, on: bool) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "event", .value = .{ .text = if (on) "discovery-on" else "discovery-off" } }}) };
}

/// The `/discovery` answer's JSON: `{on, since}`, or `{"on":false}` with no record.
pub fn json(a: Allocator, rec: ?Value) ![]const u8 {
    const r = rec orelse return a.dupe(u8, "{\"on\":false}");
    if (!eql(u8, r.getText("kind") orelse "", kind)) return a.dupe(u8, "{\"on\":false}");
    const on = if (r.get("on")) |v| v == .boolean and v.boolean else false;
    if (r.getUint("since")) |s| return std.fmt.allocPrint(a, "{{\"on\":{s},\"since\":{d}}}", .{ if (on) "true" else "false", s });
    return std.fmt.allocPrint(a, "{{\"on\":{s}}}", .{if (on) "true" else "false"});
}
