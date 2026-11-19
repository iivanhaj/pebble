import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parseMemory } from "./config.js";

test("defaults: port 6380, AOF off", () => {
  assert.deepEqual(parseArgs([]), { port: 6380, dir: ".", dbfilename: "dump.pebble", appendonly: false, appendfilename: "appendonly.aof", appendfsync: "everysec", maxmemory: 0, maxmemoryPolicy: "noeviction" });
});

test("reads --name value pairs", () => {
  const config = parseArgs(["--port", "7000", "--appendonly", "yes", "--dir", "data", "--appendfilename", "x.aof", "--appendfsync", "always", "--dbfilename", "snap.pebble"]);
  assert.deepEqual(config, { port: 7000, dir: "data", dbfilename: "snap.pebble", appendonly: true, appendfilename: "x.aof", appendfsync: "always", maxmemory: 0, maxmemoryPolicy: "noeviction" });
});

test("rejects bad input", () => {
  assert.throws(() => parseArgs(["--port"]), /Expected "--name value"/);
  assert.throws(() => parseArgs(["port", "7000"]), /Expected "--name value"/);
  assert.throws(() => parseArgs(["--port", "abc"]), /Invalid port/);
  assert.throws(() => parseArgs(["--appendonly", "true"]), /must be yes or no/);
  assert.throws(() => parseArgs(["--appendfsync", "sometimes"]), /must be always, everysec or no/);
  assert.throws(() => parseArgs(["--colour", "blue"]), /Unknown setting: --colour/);
});

test("--maxmemory understands Redis's units", () => {
  assert.equal(parseMemory("1000"), 1000);
  assert.equal(parseMemory("100mb"), 100 * 1024 * 1024);
  assert.equal(parseMemory("100m"), 100_000_000);
  assert.equal(parseMemory("2GB"), 2 * 1024 ** 3);
  assert.equal(parseMemory("64kb"), 65536);
  assert.throws(() => parseMemory("lots"), /Invalid memory size/);
  assert.equal(parseArgs(["--maxmemory", "1mb", "--maxmemory-policy", "allkeys-lru-exact"]).maxmemory, 1024 * 1024);
  assert.throws(() => parseArgs(["--maxmemory-policy", "volatile-ttl"]), /must be one of noeviction, allkeys-lru-exact/);
});
