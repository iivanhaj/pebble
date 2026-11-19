import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand as run, onWrite } from "./commands/index.js";
import { configureEviction, type EvictionPolicy } from "./eviction.js";
import { sizeOf } from "./values.js";
import * as store from "./store.js";

const VALUE = "x".repeat(100);
const KEY_SIZE = sizeOf("k0", VALUE); // every key below is k<digit>, so all the same size

function limit(keys: number, policy: EvictionPolicy) {
  store.clear();
  configureEviction({ maxmemory: keys * KEY_SIZE, policy });
}

beforeEach(() => store.clear());
afterEach(() => {
  configureEviction({ maxmemory: 0, policy: "noeviction" });
  onWrite(null);
});

const OOM = { error: "OOM command not allowed when used memory > 'maxmemory'." };

test("noeviction: commands that add data get OOM; reads and deletes still work", () => {
  limit(3, "noeviction");
  for (const key of ["k0", "k1", "k2"]) run(["SET", key, VALUE]); // exactly at the limit
  run(["SET", "k3", VALUE]); // allowed: memory wasn't over yet; now it is
  assert.deepEqual(run(["SET", "k4", VALUE]), OOM);
  assert.deepEqual(run(["LPUSH", "l", "a"]), OOM);
  assert.deepEqual(run(["INCR", "n"]), OOM);
  assert.equal(run(["GET", "k0"]), VALUE);
  assert.equal(run(["DEL", "k0"]), 1);
  assert.deepEqual(run(["SET", "k4", VALUE]), { simple: "OK" }); // room again
  assert.equal(run(["DBSIZE"]), 4); // nothing was evicted
});

test("allkeys-lru-exact: the least recently used key is evicted first", () => {
  limit(5, "allkeys-lru-exact");
  for (const key of ["k0", "k1", "k2", "k3", "k4"]) run(["SET", key, VALUE]);
  run(["GET", "k0"]); // k0 is used again, so k1 is now the oldest
  run(["SET", "k5", VALUE]); // over the limit; evicts before the next command

  assert.equal(run(["EXISTS", "k1"]), 0);
  assert.equal(run(["EXISTS", "k0"]), 1);
  assert.equal(run(["DBSIZE"]), 5);
  assert.ok(store.usedMemory() <= 5 * KEY_SIZE);
});

test("allkeys-lru-exact: keeps evicting in LRU order", () => {
  limit(3, "allkeys-lru-exact");
  for (let i = 0; i < 10; i++) run(["SET", `k${i}`, VALUE]);
  run(["PING"]); // triggers the last eviction
  assert.deepEqual(run(["MGET", "k6", "k7", "k8", "k9"]), [null, VALUE, VALUE, VALUE]);
  assert.match(run(["INFO", "stats"]) as string, /evicted_keys:7/);
});

test("each eviction is recorded as a DEL, so the AOF doesn't bring the key back", () => {
  limit(2, "allkeys-lru-exact");
  const recorded: string[][] = [];
  onWrite((commands) => recorded.push(...commands));
  run(["SET", "k0", VALUE]);
  run(["SET", "k1", VALUE]);
  run(["SET", "k2", VALUE]);
  run(["PING"]);
  assert.deepEqual(recorded, [
    ["SET", "k0", VALUE],
    ["SET", "k1", VALUE],
    ["SET", "k2", VALUE],
    ["DEL", "k0"],
  ]);
});

test("any type can be evicted, and big keys free a lot at once", () => {
  limit(3, "allkeys-lru-exact");
  run(["RPUSH", "k0", ...Array.from({ length: 20 }, () => VALUE)]); // much bigger than one string key
  run(["SET", "k1", VALUE]);
  run(["PING"]); // the list alone is over the limit, and it's the oldest
  assert.equal(run(["EXISTS", "k0"]), 0);
  assert.equal(run(["GET", "k1"]), VALUE);
});

test("no limit (maxmemory 0) never evicts", () => {
  configureEviction({ maxmemory: 0, policy: "allkeys-lru-exact" });
  for (let i = 0; i < 100; i++) run(["SET", `key${i}`, VALUE]);
  assert.equal(run(["DBSIZE"]), 100);
});

test("INFO shows the limit and policy", () => {
  limit(3, "allkeys-lru-exact");
  const info = run(["INFO", "memory"]) as string;
  assert.match(info, new RegExp(`maxmemory:${3 * KEY_SIZE}\r\n`));
  assert.match(info, /maxmemory_policy:allkeys-lru-exact\r\n/);
});
