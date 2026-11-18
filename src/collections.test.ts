// Lists, hashes, sets, and what happens when a command meets the wrong type.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand as run } from "./commands/index.js";
import * as store from "./store.js";

beforeEach(() => store.clear());

const WRONGTYPE = { error: "WRONGTYPE Operation against a key holding the wrong kind of value" };

// ---- Lists ----

test("LPUSH adds to the front one at a time; RPUSH adds to the back", () => {
  assert.equal(run(["LPUSH", "l", "a", "b", "c"]), 3);
  assert.deepEqual(run(["LRANGE", "l", "0", "-1"]), ["c", "b", "a"]);
  assert.equal(run(["RPUSH", "l", "x", "y"]), 5);
  assert.deepEqual(run(["LRANGE", "l", "0", "-1"]), ["c", "b", "a", "x", "y"]);
});

test("LRANGE: negative indexes, out-of-range indexes, empty ranges", () => {
  run(["RPUSH", "l", "a", "b", "c", "d", "e"]);
  assert.deepEqual(run(["LRANGE", "l", "1", "3"]), ["b", "c", "d"]);
  assert.deepEqual(run(["LRANGE", "l", "-2", "-1"]), ["d", "e"]);
  assert.deepEqual(run(["LRANGE", "l", "-100", "1"]), ["a", "b"]);
  assert.deepEqual(run(["LRANGE", "l", "3", "100"]), ["d", "e"]);
  assert.deepEqual(run(["LRANGE", "l", "3", "1"]), []);
  assert.deepEqual(run(["LRANGE", "l", "5", "10"]), []);
  assert.deepEqual(run(["LRANGE", "l", "0", "-6"]), []);
  assert.deepEqual(run(["LRANGE", "missing", "0", "-1"]), []);
  assert.deepEqual(run(["LRANGE", "l", "zero", "1"]), { error: "ERR value is not an integer or out of range" });
});

test("LPOP and RPOP; popping the last element deletes the key", () => {
  run(["RPUSH", "l", "a", "b", "c"]);
  assert.equal(run(["LPOP", "l"]), "a");
  assert.equal(run(["RPOP", "l"]), "c");
  assert.equal(run(["LPOP", "l"]), "b");
  assert.equal(run(["EXISTS", "l"]), 0);
  assert.equal(run(["LPOP", "l"]), null);
  assert.equal(run(["RPOP", "missing"]), null);
});

// ---- Hashes ----

test("HSET counts only new fields; HGET and HGETALL read them", () => {
  assert.equal(run(["HSET", "user:1", "name", "Jahnavi", "lang", "TS"]), 2);
  assert.equal(run(["HSET", "user:1", "lang", "Java", "city", "Kolkata"]), 1); // lang was updated, not new
  assert.equal(run(["HGET", "user:1", "lang"]), "Java");
  assert.equal(run(["HGET", "user:1", "nope"]), null);
  assert.equal(run(["HGET", "missing", "name"]), null);
  assert.deepEqual(run(["HGETALL", "user:1"]), ["name", "Jahnavi", "lang", "Java", "city", "Kolkata"]);
  assert.deepEqual(run(["HGETALL", "missing"]), []);
});

test("HDEL; removing the last field deletes the key", () => {
  run(["HSET", "h", "a", "1", "b", "2"]);
  assert.equal(run(["HDEL", "h", "a", "nope"]), 1);
  assert.equal(run(["HDEL", "h", "b"]), 1);
  assert.equal(run(["EXISTS", "h"]), 0);
  assert.equal(run(["HDEL", "h", "b"]), 0);
});

test("HSET needs field-value pairs", () => {
  assert.deepEqual(run(["HSET", "h", "a", "1", "b"]), { error: "ERR wrong number of arguments for 'hset' command" });
  assert.equal(run(["EXISTS", "h"]), 0);
});

// ---- Sets ----

test("SADD ignores duplicates; SMEMBERS and SISMEMBER", () => {
  assert.equal(run(["SADD", "s", "a", "b", "a"]), 2);
  assert.equal(run(["SADD", "s", "b", "c"]), 1);
  assert.deepEqual((run(["SMEMBERS", "s"]) as string[]).sort(), ["a", "b", "c"]);
  assert.equal(run(["SISMEMBER", "s", "a"]), 1);
  assert.equal(run(["SISMEMBER", "s", "z"]), 0);
  assert.equal(run(["SISMEMBER", "missing", "a"]), 0);
  assert.deepEqual(run(["SMEMBERS", "missing"]), []);
});

test("SREM; removing the last member deletes the key", () => {
  run(["SADD", "s", "a", "b"]);
  assert.equal(run(["SREM", "s", "a", "z"]), 1);
  assert.equal(run(["SREM", "s", "b"]), 1);
  assert.equal(run(["EXISTS", "s"]), 0);
});

// ---- Types ----

test("using a key as the wrong type gives WRONGTYPE", () => {
  run(["SET", "str", "hello"]);
  run(["RPUSH", "list", "a"]);
  run(["HSET", "hash", "f", "v"]);
  run(["SADD", "set", "m"]);

  assert.deepEqual(run(["GET", "list"]), WRONGTYPE);
  assert.deepEqual(run(["INCR", "hash"]), WRONGTYPE);
  assert.deepEqual(run(["LPUSH", "str", "x"]), WRONGTYPE);
  assert.deepEqual(run(["LRANGE", "set", "0", "-1"]), WRONGTYPE);
  assert.deepEqual(run(["HSET", "list", "f", "v"]), WRONGTYPE);
  assert.deepEqual(run(["HGET", "set", "f"]), WRONGTYPE);
  assert.deepEqual(run(["SADD", "hash", "m"]), WRONGTYPE);
  assert.deepEqual(run(["SISMEMBER", "str", "m"]), WRONGTYPE);
});

test("a WRONGTYPE command changes nothing", () => {
  run(["SET", "k", "hello"]);
  run(["LPUSH", "k", "x"]);
  assert.equal(run(["GET", "k"]), "hello");
});

test("MGET returns null for keys that aren't strings", () => {
  run(["SET", "a", "1"]);
  run(["RPUSH", "l", "x"]);
  assert.deepEqual(run(["MGET", "a", "l"]), ["1", null]);
});

test("SET replaces a key of any type", () => {
  run(["RPUSH", "k", "a"]);
  assert.deepEqual(run(["SET", "k", "now a string"]), { simple: "OK" });
  assert.equal(run(["GET", "k"]), "now a string");
});

test("DEL, EXISTS, EXPIRE and TTL work on every type", () => {
  run(["RPUSH", "l", "a"]);
  run(["HSET", "h", "f", "v"]);
  run(["SADD", "s", "m"]);
  assert.equal(run(["EXISTS", "l", "h", "s"]), 3);
  assert.equal(run(["EXPIRE", "h", "100"]), 1);
  assert.equal(run(["TTL", "h"]), 100);
  assert.equal(run(["DEL", "l", "h", "s"]), 3);
});

test("adding to a list, hash or set keeps its timeout", () => {
  run(["RPUSH", "l", "a"]);
  run(["EXPIRE", "l", "100"]);
  run(["RPUSH", "l", "b"]);
  assert.equal(run(["TTL", "l"]), 100);
});
