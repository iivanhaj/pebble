import { test, beforeEach, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AofWriter, loadAof } from "./aof.js";
import { parse } from "../resp/parser.js";
import { runCommand as run, onWrite } from "../commands/index.js";
import * as store from "../store.js";

let dir: string;
let file: string;

beforeEach(() => {
  store.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-aof-"));
  file = path.join(dir, "appendonly.aof");
});
afterEach(() => {
  onWrite(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Reads every command back out of the file with the same parser the server uses.
function readCommands(): string[][] {
  let bytes = fs.readFileSync(file);
  const commands: string[][] = [];
  let result;
  while ((result = parse(bytes)) !== null) {
    commands.push(result.words);
    bytes = bytes.subarray(result.used);
  }
  assert.equal(bytes.length, 0, "leftover bytes at the end of the file");
  return commands;
}

test("writes commands to the file in RESP format", () => {
  const aof = new AofWriter(file);
  aof.append([["SET", "name", "Jahnavi"]]);
  aof.append([["RPUSH", "l", "a", "b"], ["DEL", "x"]]);
  aof.close();

  const firstCommand = "*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$7\r\nJahnavi\r\n";
  assert.equal(fs.readFileSync(file, "latin1").slice(0, firstCommand.length), firstCommand);
  assert.deepEqual(readCommands(), [
    ["SET", "name", "Jahnavi"],
    ["RPUSH", "l", "a", "b"],
    ["DEL", "x"],
  ]);
});

test("appends to an existing file instead of replacing it", () => {
  const first = new AofWriter(file);
  first.append([["SET", "a", "1"]]);
  first.close();
  const second = new AofWriter(file);
  second.append([["SET", "b", "2"]]);
  second.close();
  assert.deepEqual(readCommands(), [
    ["SET", "a", "1"],
    ["SET", "b", "2"],
  ]);
});

test("records exactly the write commands, when hooked up with onWrite", () => {
  const aof = new AofWriter(file);
  onWrite((commands) => aof.append(commands));
  run(["SET", "k", "v"]);
  run(["GET", "k"]);
  run(["SADD", "s", "x"]);
  run(["INCR", "k"]); // error: not recorded
  aof.close();
  assert.deepEqual(readCommands(), [
    ["SET", "k", "v"],
    ["SADD", "s", "x"],
  ]);
});

test("binary values survive the round trip", () => {
  const value = Buffer.from([0, 13, 10, 255]).toString("latin1");
  const aof = new AofWriter(file);
  aof.append([["SET", "bin", value]]);
  aof.close();
  assert.deepEqual(readCommands(), [["SET", "bin", value]]);
});

// ---- Loading ----

// Runs commands with the AOF recording, then "restarts": wipes the store and loads the file.
function recordThenRestart(commands: string[][]) {
  const aof = new AofWriter(file);
  onWrite((toRecord) => aof.append(toRecord));
  for (const words of commands) run(words);
  onWrite(null);
  aof.close();
  store.clear();
  return loadAof(file);
}

test("a missing file loads nothing", () => {
  assert.deepEqual(loadAof(file), { commands: 0, truncatedBytes: 0 });
});

test("restarting rebuilds every type of data", () => {
  const result = recordThenRestart([
    ["SET", "name", "Jahnavi"],
    ["INCR", "visits"],
    ["INCR", "visits"],
    ["RPUSH", "queue", "a", "b", "c"],
    ["LPOP", "queue"],
    ["HSET", "user:1", "name", "J", "lang", "TS"],
    ["HDEL", "user:1", "lang"],
    ["SADD", "tags", "x", "y"],
    ["SET", "gone", "v"],
    ["DEL", "gone"],
  ]);
  assert.deepEqual(result, { commands: 10, truncatedBytes: 0 });
  assert.equal(run(["GET", "name"]), "Jahnavi");
  assert.equal(run(["GET", "visits"]), "2");
  assert.deepEqual(run(["LRANGE", "queue", "0", "-1"]), ["b", "c"]);
  assert.deepEqual(run(["HGETALL", "user:1"]), ["name", "J"]);
  assert.deepEqual((run(["SMEMBERS", "tags"]) as string[]).sort(), ["x", "y"]);
  assert.equal(run(["EXISTS", "gone"]), 0);
});

test("a timeout keeps counting down across a restart", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const aof = new AofWriter(file);
  onWrite((toRecord) => aof.append(toRecord));
  run(["SET", "session", "abc", "EX", "100"]);
  onWrite(null);
  aof.close();

  t.mock.timers.tick(30_000); // the server is down for 30 seconds
  store.clear();
  loadAof(file);
  assert.equal(run(["TTL", "session"]), 70); // not back to 100
});

test("keys whose timeout passed while the server was down don't come back", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const aof = new AofWriter(file);
  onWrite((toRecord) => aof.append(toRecord));
  run(["SET", "k", "1", "EX", "10"]);
  run(["INCR", "k"]); // happened before the deadline
  onWrite(null);
  aof.close();

  t.mock.timers.tick(60_000);
  store.clear();
  loadAof(file);
  // Loaded, still in memory, but past its deadline: the first read removes it.
  assert.equal(store.size(), 1);
  // If expiry ran during loading, PEXPIREAT would delete k and INCR would
  // recreate it with no timeout: a key that never expires. TTL would be -1.
  assert.equal(run(["TTL", "k"]), -2);
  assert.equal(store.size(), 0);
});

test("a half-written last command is cut off, and the rest loads", () => {
  const aof = new AofWriter(file);
  aof.append([["SET", "a", "1"], ["SET", "b", "2"]]);
  aof.close();
  const goodSize = fs.statSync(file).size;
  const halfWritten = "*3\r\n$3\r\nSET\r\n$1\r\nc\r\n$1"; // crashed mid-write
  fs.appendFileSync(file, halfWritten);

  assert.deepEqual(loadAof(file), { commands: 2, truncatedBytes: halfWritten.length });
  assert.equal(fs.statSync(file).size, goodSize);
  assert.equal(run(["GET", "b"]), "2");
  assert.equal(run(["GET", "c"]), null);
});

test("garbage in the file refuses to load", () => {
  fs.writeFileSync(file, "*1\r\n$4\r\nPING\r\nthis is not RESP\r\n");
  assert.throws(() => loadAof(file), /Bad AOF .* at byte 14: Protocol error/);
});

// ---- fsync policies ----

function spyOnFsync(t: TestContext) {
  const sync = t.mock.method(fs, "fsyncSync");
  const background = t.mock.method(fs, "fsync", (_fd: number, done: (err: Error | null) => void) => done(null));
  return { sync, background };
}

test("appendfsync always: fsync after every write, before append returns", (t) => {
  const { sync, background } = spyOnFsync(t);
  const aof = new AofWriter(file, "always");
  aof.append([["SET", "a", "1"]]);
  aof.append([["SET", "b", "2"]]);
  assert.equal(sync.mock.callCount(), 2);
  aof.close();
  assert.equal(sync.mock.callCount(), 2); // nothing left to sync
  assert.equal(background.mock.callCount(), 0);
});

test("appendfsync everysec: one background fsync per second, only if something was written", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { sync, background } = spyOnFsync(t);
  const aof = new AofWriter(file, "everysec");
  aof.append([["SET", "a", "1"]]);
  aof.append([["SET", "b", "2"]]);
  assert.equal(background.mock.callCount(), 0);
  t.mock.timers.tick(1000);
  assert.equal(background.mock.callCount(), 1); // two writes, one fsync
  t.mock.timers.tick(1000);
  assert.equal(background.mock.callCount(), 1); // nothing new written
  aof.append([["SET", "c", "3"]]);
  aof.close(); // syncs what's left before closing
  assert.equal(sync.mock.callCount(), 1);
});

test("appendfsync no: never fsync", (t) => {
  const { sync, background } = spyOnFsync(t);
  const aof = new AofWriter(file, "no");
  aof.append([["SET", "a", "1"]]);
  aof.close();
  assert.equal(sync.mock.callCount() + background.mock.callCount(), 0);
});
