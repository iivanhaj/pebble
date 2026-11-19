import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand as run } from "./commands/index.js";
import * as store from "./store.js";

beforeEach(() => store.clear());

test("starts at 0; grows with SET, shrinks back to 0 with DEL", () => {
  assert.equal(store.usedMemory(), 0);
  run(["SET", "k", "v"]);
  const small = store.usedMemory();
  assert.ok(small > 0);
  run(["SET", "k", "a much longer value than before"]);
  assert.equal(store.usedMemory(), small + "a much longer value than before".length - 1);
  run(["DEL", "k"]);
  assert.equal(store.usedMemory(), 0);
});

test("lists, hashes and sets grow and shrink as items change", () => {
  run(["RPUSH", "l", "a", "b"]);
  const twoItems = store.usedMemory();
  run(["RPUSH", "l", "c"]);
  assert.ok(store.usedMemory() > twoItems);
  run(["RPOP", "l"]);
  assert.equal(store.usedMemory(), twoItems);

  run(["SADD", "s", "x"]);
  const oneMember = store.usedMemory();
  run(["SADD", "s", "x"]); // already there: no change
  assert.equal(store.usedMemory(), oneMember);

  run(["HSET", "h", "f", "short"]);
  const before = store.usedMemory();
  run(["HSET", "h", "f", "longer!"]); // same field, longer value
  assert.equal(store.usedMemory(), before + 2);
});

test("expired keys stop counting once they're removed", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  run(["SET", "a", "v", "EX", "1"]);
  run(["SET", "b", "v", "EX", "1"]);
  t.mock.timers.tick(1001);
  run(["GET", "a"]); // lazy expiry
  store.activeExpireCycle(); // active expiry gets b
  assert.equal(store.usedMemory(), 0);
});

test("the running total always matches a recount, over 5,000 random commands", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const key = () => `k${Math.floor(Math.random() * 20)}`;
  const word = () => "x".repeat(Math.floor(Math.random() * 30));
  const commands = [
    () => ["SET", key(), word()],
    () => ["SET", key(), word(), "PX", String(1 + Math.floor(Math.random() * 100))],
    () => ["DEL", key()],
    () => ["INCR", key()],
    () => ["MSET", key(), word(), key(), word()],
    () => ["LPUSH", key(), word(), word()],
    () => ["RPOP", key()],
    () => ["HSET", key(), word(), word()],
    () => ["HDEL", key(), word()],
    () => ["SADD", key(), word()],
    () => ["SREM", key(), word()],
    () => ["EXPIRE", key(), "-1"],
    () => ["GET", key()],
  ];
  for (let step = 0; step < 5000; step++) {
    run(commands[Math.floor(Math.random() * commands.length)]());
    if (step % 10 === 0) t.mock.timers.tick(10);
    if (step % 50 === 0) store.activeExpireCycle();
    assert.equal(store.usedMemory(), store.measureFromScratch(), `step ${step}`);
  }
});

test("INFO memory reports used_memory", () => {
  run(["SET", "k", "v"]);
  assert.equal(run(["INFO", "memory"]), `# Memory\r\nused_memory:${store.usedMemory()}\r\n`);
});
