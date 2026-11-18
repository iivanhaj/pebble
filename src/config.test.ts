import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./config.js";

test("defaults: port 6380, AOF off", () => {
  assert.deepEqual(parseArgs([]), { port: 6380, dir: ".", dbfilename: "dump.pebble", appendonly: false, appendfilename: "appendonly.aof", appendfsync: "everysec" });
});

test("reads --name value pairs", () => {
  const config = parseArgs(["--port", "7000", "--appendonly", "yes", "--dir", "data", "--appendfilename", "x.aof", "--appendfsync", "always", "--dbfilename", "snap.pebble"]);
  assert.deepEqual(config, { port: 7000, dir: "data", dbfilename: "snap.pebble", appendonly: true, appendfilename: "x.aof", appendfsync: "always" });
});

test("rejects bad input", () => {
  assert.throws(() => parseArgs(["--port"]), /Expected "--name value"/);
  assert.throws(() => parseArgs(["port", "7000"]), /Expected "--name value"/);
  assert.throws(() => parseArgs(["--port", "abc"]), /Invalid port/);
  assert.throws(() => parseArgs(["--appendonly", "true"]), /must be yes or no/);
  assert.throws(() => parseArgs(["--appendfsync", "sometimes"]), /must be always, everysec or no/);
  assert.throws(() => parseArgs(["--colour", "blue"]), /Unknown setting: --colour/);
});
