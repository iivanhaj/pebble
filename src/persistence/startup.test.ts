// Restarts in every combination of snapshot and AOF. Each "restart" wipes the
// store and runs startPersistence again on the same folder.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startPersistence, type Persistence } from "./startup.js";
import { parseArgs } from "../config.js";
import { runCommand as run } from "../commands/index.js";
import * as store from "../store.js";

let dir: string;
let running: Persistence | null = null;

beforeEach(() => {
  store.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-startup-"));
});
afterEach(() => {
  running?.close();
  running = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(appendonly: boolean): string[] {
  running?.close();
  store.clear();
  running = startPersistence(parseArgs(["--dir", dir, "--appendonly", appendonly ? "yes" : "no", "--appendfsync", "no"]));
  return running.messages;
}

const OK = { simple: "OK" };

test("SAVE, DBSIZE and LASTSAVE", () => {
  start(false);
  run(["SET", "a", "1"]);
  run(["SADD", "s", "x"]);
  assert.equal(run(["DBSIZE"]), 2);
  const before = Math.floor(Date.now() / 1000);
  assert.deepEqual(run(["SAVE"]), OK);
  assert.ok((run(["LASTSAVE"]) as number) >= before);
  assert.ok(fs.existsSync(path.join(dir, "dump.pebble")));
});

test("snapshot only: SAVE, restart, data is back", () => {
  start(false);
  run(["SET", "name", "Jahnavi"]);
  run(["RPUSH", "queue", "a", "b"]);
  run(["SAVE"]);
  run(["SET", "after", "not saved"]); // no AOF: lost on restart, as expected

  const messages = start(false);
  assert.match(messages[0], /Loaded 2 keys from snapshot/);
  assert.equal(run(["GET", "name"]), "Jahnavi");
  assert.deepEqual(run(["LRANGE", "queue", "0", "-1"]), ["a", "b"]);
  assert.equal(run(["GET", "after"]), null);
});

test("snapshot + AOF: only the AOF written after the snapshot is replayed", () => {
  start(true);
  run(["SET", "counter", "0"]);
  run(["INCR", "counter"]);
  run(["INCR", "counter"]); // counter = 2
  run(["SAVE"]);
  run(["INCR", "counter"]); // counter = 3
  run(["RPUSH", "later", "x"]);

  const messages = start(true);
  assert.match(messages[0], /Loaded 1 keys from snapshot/); // counter
  assert.match(messages[1], /Replayed 2 commands .* \(from byte \d+\)/); // INCR, RPUSH
  // Replaying the whole AOF on top of the snapshot would give 5.
  assert.equal(run(["GET", "counter"]), "3");
  assert.deepEqual(run(["LRANGE", "later", "0", "-1"]), ["x"]);
});

test("AOF only, no snapshot: the whole AOF is replayed", () => {
  start(true);
  run(["SET", "a", "1"]);
  run(["INCR", "a"]);
  const messages = start(true);
  assert.match(messages[0], /Replayed 2 commands/);
  assert.equal(run(["GET", "a"]), "2");
});

test("snapshot taken without AOF, then AOF switched on: nothing is lost over two restarts", () => {
  start(false);
  run(["SET", "old", "from the snapshot"]);
  run(["SAVE"]);

  const messages = start(true); // AOF on for the first time
  assert.ok(messages.includes("Saved a new snapshot to go with the new AOF"));
  run(["SET", "new", "from the AOF"]);

  start(true);
  assert.equal(run(["GET", "old"]), "from the snapshot");
  assert.equal(run(["GET", "new"]), "from the AOF");
});

test("an AOF shorter than the snapshot expects refuses to start", () => {
  start(true);
  run(["SET", "a", "1"]);
  run(["SAVE"]);
  running!.close();
  running = null;
  fs.writeFileSync(path.join(dir, "appendonly.aof"), ""); // someone emptied the AOF
  assert.throws(() => start(true), /shorter \(0 bytes\) than the snapshot expects/);
});
