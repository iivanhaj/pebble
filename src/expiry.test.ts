// Expiry tests. t.mock.timers fakes Date.now(), so t.mock.timers.tick(ms) jumps
// forward in time instantly instead of the test actually waiting.
import { test, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { runCommand as run } from "./commands/index.js";
import * as store from "./store.js";

beforeEach(() => store.clear());

const fakeClock = (t: TestContext) => t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
const OK = { simple: "OK" };

// ---- SET options ----

test("SET EX: the key disappears after the timeout", (t) => {
  fakeClock(t);
  assert.deepEqual(run(["SET", "k", "v", "EX", "10"]), OK);
  t.mock.timers.tick(10_000);
  assert.equal(run(["GET", "k"]), "v"); // exactly at the deadline: still there
  t.mock.timers.tick(1);
  assert.equal(run(["GET", "k"]), null);
});

test("SET PX: timeout in milliseconds; options are case-insensitive", (t) => {
  fakeClock(t);
  run(["SET", "k", "v", "px", "1500"]);
  t.mock.timers.tick(1500);
  assert.equal(run(["GET", "k"]), "v");
  t.mock.timers.tick(1);
  assert.equal(run(["GET", "k"]), null);
});

test("a plain SET removes an old timeout", (t) => {
  fakeClock(t);
  run(["SET", "k", "v", "EX", "10"]);
  run(["SET", "k", "v2"]);
  assert.equal(run(["TTL", "k"]), -1);
});

test("SET NX only sets a missing key; SET XX only sets an existing key", () => {
  assert.equal(run(["SET", "k", "1", "XX"]), null);
  assert.deepEqual(run(["SET", "k", "1", "NX"]), OK);
  assert.equal(run(["SET", "k", "2", "NX"]), null);
  assert.equal(run(["GET", "k"]), "1");
  assert.deepEqual(run(["SET", "k", "3", "XX"]), OK);
  assert.equal(run(["GET", "k"]), "3");
});

test("SET NX treats an expired key as missing", (t) => {
  fakeClock(t);
  run(["SET", "k", "old", "EX", "1"]);
  t.mock.timers.tick(1001);
  assert.deepEqual(run(["SET", "k", "new", "NX"]), OK);
});

test("SET option errors", () => {
  const syntax = { error: "ERR syntax error" };
  assert.deepEqual(run(["SET", "k", "v", "EX"]), syntax);
  assert.deepEqual(run(["SET", "k", "v", "NX", "XX"]), syntax);
  assert.deepEqual(run(["SET", "k", "v", "EX", "1", "PX", "1"]), syntax);
  assert.deepEqual(run(["SET", "k", "v", "FOO"]), syntax);
  assert.deepEqual(run(["SET", "k", "v", "EX", "abc"]), { error: "ERR value is not an integer or out of range" });
  assert.deepEqual(run(["SET", "k", "v", "EX", "1.5"]), { error: "ERR value is not an integer or out of range" });
  assert.deepEqual(run(["SET", "k", "v", "EX", "0"]), { error: "ERR invalid expire time in 'set' command" });
  assert.deepEqual(run(["SET", "k", "v", "PX", "-5"]), { error: "ERR invalid expire time in 'set' command" });
  assert.equal(run(["GET", "k"]), null); // nothing was set by any of those
});

// ---- EXPIRE, TTL, PERSIST ----

test("EXPIRE sets a timeout; returns 0 for a missing key", (t) => {
  fakeClock(t);
  run(["SET", "k", "v"]);
  assert.equal(run(["EXPIRE", "k", "5"]), 1);
  assert.equal(run(["EXPIRE", "missing", "5"]), 0);
  t.mock.timers.tick(5001);
  assert.equal(run(["EXISTS", "k"]), 0);
});

test("EXPIRE can replace an existing timeout", (t) => {
  fakeClock(t);
  run(["SET", "k", "v", "EX", "100"]);
  run(["EXPIRE", "k", "5"]);
  assert.equal(run(["TTL", "k"]), 5);
});

test("EXPIRE with zero or a negative number deletes the key", () => {
  run(["SET", "k", "v"]);
  assert.equal(run(["EXPIRE", "k", "-1"]), 1);
  assert.equal(run(["GET", "k"]), null);
});

test("EXPIRE rejects non-integers", () => {
  run(["SET", "k", "v"]);
  assert.deepEqual(run(["EXPIRE", "k", "soon"]), { error: "ERR value is not an integer or out of range" });
});

test("TTL: -2 missing, -1 no timeout, otherwise seconds left (rounded)", (t) => {
  fakeClock(t);
  assert.equal(run(["TTL", "missing"]), -2);
  run(["SET", "plain", "v"]);
  assert.equal(run(["TTL", "plain"]), -1);
  run(["SET", "k", "v", "EX", "10"]);
  assert.equal(run(["TTL", "k"]), 10);
  t.mock.timers.tick(6400);
  assert.equal(run(["TTL", "k"]), 4); // 3.6s left
  t.mock.timers.tick(3601);
  assert.equal(run(["TTL", "k"]), -2);
});

test("PERSIST removes a timeout", (t) => {
  fakeClock(t);
  run(["SET", "k", "v", "EX", "10"]);
  assert.equal(run(["PERSIST", "k"]), 1);
  assert.equal(run(["PERSIST", "k"]), 0); // no timeout left to remove
  assert.equal(run(["PERSIST", "missing"]), 0);
  t.mock.timers.tick(60_000);
  assert.equal(run(["GET", "k"]), "v");
  assert.equal(run(["TTL", "k"]), -1);
});

test("expired keys look missing to every command (lazy expiry)", (t) => {
  fakeClock(t);
  run(["SET", "k", "v", "EX", "1"]);
  t.mock.timers.tick(1001);
  assert.equal(run(["EXISTS", "k"]), 0);
  assert.equal(run(["DEL", "k"]), 0);
  assert.equal(run(["EXPIRE", "k", "10"]), 0);
  assert.equal(run(["PERSIST", "k"]), 0);
});

// ---- Active expiry ----

test("active expiry deletes expired keys that nobody reads", (t) => {
  fakeClock(t);
  for (let i = 0; i < 100; i++) run(["SET", `temp:${i}`, "v", "EX", "1"]);
  for (let i = 0; i < 100; i++) run(["SET", `keep:${i}`, "v"]);
  t.mock.timers.tick(1001);

  assert.equal(store.size(), 200); // expired, but not cleaned up yet
  assert.equal(store.activeExpireCycle(), 100);
  assert.equal(store.size(), 100);
});

test("active expiry leaves keys that haven't expired", (t) => {
  fakeClock(t);
  for (let i = 0; i < 50; i++) run(["SET", `k:${i}`, "v", "EX", "10"]);
  t.mock.timers.tick(5000);
  assert.equal(store.activeExpireCycle(), 0);
  assert.equal(store.size(), 50);
});

test("timeouts stay correct after keys are removed from the middle", (t) => {
  fakeClock(t);
  run(["SET", "a", "v", "EX", "10"]);
  run(["SET", "b", "v", "EX", "20"]);
  run(["SET", "c", "v", "EX", "30"]);
  run(["SET", "d", "v", "EX", "40"]);
  run(["PERSIST", "a"]); // removed from the front
  run(["DEL", "c"]); // removed from the middle
  assert.equal(run(["TTL", "b"]), 20);
  assert.equal(run(["TTL", "d"]), 40);

  t.mock.timers.tick(100_000);
  assert.equal(store.activeExpireCycle(), 2); // b and d
  assert.equal(store.size(), 1); // only a, which no longer expires
  assert.equal(run(["GET", "a"]), "v");
});

// ---- PEXPIREAT ----

test("PEXPIREAT sets an absolute timeout in milliseconds", (t) => {
  fakeClock(t); // now = 1,000,000
  run(["SET", "k", "v"]);
  assert.equal(run(["PEXPIREAT", "k", "1005000"]), 1);
  assert.equal(run(["TTL", "k"]), 5);
  assert.equal(run(["PEXPIREAT", "missing", "1005000"]), 0);
  t.mock.timers.tick(5001);
  assert.equal(run(["GET", "k"]), null);
});

test("PEXPIREAT with a time in the past deletes the key", (t) => {
  fakeClock(t);
  run(["SET", "k", "v"]);
  assert.equal(run(["PEXPIREAT", "k", "999999"]), 1);
  assert.equal(run(["EXISTS", "k"]), 0);
});

test("PEXPIREAT rejects non-integers", () => {
  run(["SET", "k", "v"]);
  assert.deepEqual(run(["PEXPIREAT", "k", "tomorrow"]), { error: "ERR value is not an integer or out of range" });
});
