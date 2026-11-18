import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSnapshot, loadSnapshot } from "./snapshot.js";
import { runCommand as run } from "../commands/index.js";
import * as store from "../store.js";

let dir: string;
let file: string;

beforeEach(() => {
  store.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-snapshot-"));
  file = path.join(dir, "dump.pebble");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function saveAndRestart(aofOffset = -1) {
  saveSnapshot(file, aofOffset);
  store.clear();
  return loadSnapshot(file);
}

test("every type of value survives a save and load", () => {
  const binary = Buffer.from([0, 13, 10, 255]).toString("latin1");
  run(["SET", "name", "Jahnavi"]);
  run(["SET", "bin", binary]);
  run(["SET", "empty", ""]);
  run(["RPUSH", "queue", "a", "b", "c"]);
  run(["HSET", "user:1", "name", "J", "lang", "TS"]);
  run(["SADD", "tags", "x", "y", "z"]);

  const info = saveAndRestart(1234);
  assert.equal(info.keys, 6);
  assert.equal(info.aofOffset, 1234);
  assert.equal(run(["GET", "name"]), "Jahnavi");
  assert.equal(run(["GET", "bin"]), binary);
  assert.equal(run(["GET", "empty"]), "");
  assert.deepEqual(run(["LRANGE", "queue", "0", "-1"]), ["a", "b", "c"]);
  assert.deepEqual(run(["HGETALL", "user:1"]), ["name", "J", "lang", "TS"]);
  assert.deepEqual((run(["SMEMBERS", "tags"]) as string[]).sort(), ["x", "y", "z"]);
});

test("timeouts are saved as absolute times", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  run(["SET", "session", "abc", "EX", "100"]);
  run(["SET", "forever", "v"]);
  saveSnapshot(file, -1);

  t.mock.timers.tick(30_000); // down for 30 seconds
  store.clear();
  const info = loadSnapshot(file);
  assert.equal(info.savedAt, 1_000_000);
  assert.equal(run(["TTL", "session"]), 70);
  assert.equal(run(["TTL", "forever"]), -1);
});

test("an empty store saves and loads", () => {
  const info = saveAndRestart();
  assert.equal(info.keys, 0);
  assert.equal(info.aofOffset, -1);
  assert.equal(store.size(), 0);
});

test("a big list keeps its order", () => {
  for (let i = 0; i < 1000; i++) run(["RPUSH", "big", String(i)]);
  saveAndRestart();
  const items = run(["LRANGE", "big", "0", "-1"]) as string[];
  assert.equal(items.length, 1000);
  assert.equal(items[0], "0");
  assert.equal(items[999], "999");
});

test("saving replaces the old snapshot and leaves no temporary file", () => {
  run(["SET", "v", "1"]);
  saveSnapshot(file, -1);
  run(["SET", "v", "2"]);
  saveSnapshot(file, -1);
  assert.deepEqual(fs.readdirSync(dir), ["dump.pebble"]);
  store.clear();
  loadSnapshot(file);
  assert.equal(run(["GET", "v"]), "2");
});

test("a single flipped byte is caught by the checksum", () => {
  run(["SET", "name", "Jahnavi"]);
  saveSnapshot(file, -1);
  const bytes = fs.readFileSync(file);
  bytes[bytes.indexOf("Jahnavi", 0, "latin1")] ^= 0x01; // "Jahnavi" -> "Kahnavi"
  fs.writeFileSync(file, bytes);
  store.clear();
  assert.throws(() => loadSnapshot(file), /damaged: checksum mismatch/);
  assert.equal(store.size(), 0); // nothing half-loaded
});

test("a cut-off file is refused", () => {
  run(["SET", "name", "Jahnavi"]);
  saveSnapshot(file, -1);
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, bytes.subarray(0, bytes.length - 10));
  assert.throws(() => loadSnapshot(file), /damaged/);
});

test("a file that isn't a snapshot is refused", () => {
  fs.writeFileSync(file, "*1\r\n$4\r\nPING\r\n");
  assert.throws(() => loadSnapshot(file), /is not a Pebble snapshot/);
});
