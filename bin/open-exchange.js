#!/usr/bin/env node
// open-exchange (host/cli.ts): the Open Exchange host on skein's host (the npm package `skein`, its
// kernel one wasm file: node alone runs it). Built: dist/host/cli.js; in a checkout, else host/cli.ts.
// Settings: $SKEIN_HOME/host.env (default SKEIN_HOME ~/.skein).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.env.SKEIN_HOME ||= join(homedir(), ".skein");
const root = new URL("..", import.meta.url);
const built = new URL("dist/host/cli.js", root);
const { main } = await import(existsSync(built) ? built.href : new URL("host/cli.ts", root).href);
process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
if (process.argv[2] === "setup") process.exit(process.exitCode);
