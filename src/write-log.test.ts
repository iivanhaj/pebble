// What each command reports to onWrite, i.e. what the AOF will record.
import { test, beforeEach, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { runCommand as run, onWrite } from "./commands/index.js";
import * as store from "./store.js";

let recorded: string[][] = [];

beforeEach(() => {
  store.clear();
  recorded = [];
  onWrite((commands) => recorded.push(...commands));
});
afterEach(() => onWrite(null));

const fakeClock = (t: TestContext) => t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

test("reads record nothing", () => {
  run(["SET", "k", "v"]);
  recorded = [];
  for (const words of [["GET", "k"], ["EXISTS", "k"], ["TTL", "k"], ["MGET", "k"], ["PING"], ["INFO"]]) run(words);
  assert.deepEqual(recorded, []);
});

test("most writes are recorded exactly as sent", () => {
  run(["RPUSH", "l", "a", "b"]);
  run(["hset", "h", "f", "v"]);
  run(["INCR", "n"]);
  assert.deepEqual(recorded, [
    ["RPUSH", "l", "a", "b"],
    ["hset", "h", "f", "v"],
    ["INCR", "n"],
  ]);
});

test("SET with EX is recorded as SET + PEXPIREAT with the absolute time", (t) => {
  fakeClock(t);
  run(["SET", "k", "v", "EX", "10", "NX"]);
  assert.deepEqual(recorded, [
    ["SET", "k", "v"],
    ["PEXPIREAT", "k", "1010000"],
  ]);
});

test("EXPIRE is recorded as PEXPIREAT; an EXPIRE in the past as DEL", (t) => {
  fakeClock(t);
  run(["SET", "a", "v"]);
  run(["SET", "b", "v"]);
  recorded = [];
  run(["EXPIRE", "a", "5"]);
  run(["EXPIRE", "b", "-1"]);
  assert.deepEqual(recorded, [
    ["PEXPIREAT", "a", "1005000"],
    ["DEL", "b"],
  ]);
});

test("commands that changed nothing record nothing", () => {
  run(["SET", "k", "v"]);
  run(["RPUSH", "l", "a"]);
  recorded = [];
  run(["SET", "k", "other", "NX"]); // NX: key exists, not set
  run(["EXPIRE", "missing", "10"]); // no such key
  run(["INCR", "k"]); // error: not an integer
  run(["LPUSH", "k", "x"]); // error: WRONGTYPE
  run(["SET", "k"]); // error: wrong number of arguments
  run(["NOPE"]); // error: unknown command
  assert.deepEqual(recorded, []);
});
