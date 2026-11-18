// The real Redis client library for Node, talking to Pebble the way an app would.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Redis } from "ioredis";
import { createServer } from "./server.js";
import * as store from "./store.js";

const server = createServer();
let redis: Redis;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  redis = new Redis({ port: (server.address() as AddressInfo).port, host: "127.0.0.1" });
});

after(async () => {
  await redis.quit().catch(() => redis.disconnect()); // QUIT isn't a Pebble command yet
  server.close();
});

beforeEach(() => store.clear());

test("PING, ECHO", async () => {
  assert.equal(await redis.ping(), "PONG");
  assert.equal(await redis.echo("hello"), "hello");
});

test("SET, GET, DEL, EXISTS", async () => {
  assert.equal(await redis.set("name", "Jahnavi"), "OK");
  assert.equal(await redis.get("name"), "Jahnavi");
  assert.equal(await redis.exists("name", "nope"), 1);
  assert.equal(await redis.del("name"), 1);
  assert.equal(await redis.get("name"), null);
});

test("SET with NX and an expiry, then wait for it to expire", async () => {
  assert.equal(await redis.set("session", "abc", "PX", 100, "NX"), "OK");
  assert.equal(await redis.set("session", "xyz", "PX", 100, "NX"), null);
  assert.equal(await redis.ttl("session"), 0); // 0.1s rounds to 0
  await sleep(150);
  assert.equal(await redis.get("session"), null);
});

test("EXPIRE, TTL, PERSIST", async () => {
  await redis.set("k", "v");
  assert.equal(await redis.expire("k", 100), 1);
  assert.equal(await redis.ttl("k"), 100);
  assert.equal(await redis.persist("k"), 1);
  assert.equal(await redis.ttl("k"), -1);
});

test("INCR, DECR", async () => {
  assert.equal(await redis.incr("visits"), 1);
  assert.equal(await redis.incr("visits"), 2);
  assert.equal(await redis.decr("visits"), 1);
});

test("MSET, MGET", async () => {
  assert.equal(await redis.mset("a", "1", "b", "2"), "OK");
  assert.deepEqual(await redis.mget("a", "missing", "b"), ["1", null, "2"]);
});

test("errors come back as rejected promises", async () => {
  await redis.set("k", "not a number");
  await assert.rejects(redis.incr("k"), /ERR value is not an integer or out of range/);
  await assert.rejects(redis.call("NOPE"), /ERR unknown command 'NOPE'/);
});

test("binary values come back byte for byte", async () => {
  const bytes = Buffer.from([0, 1, 13, 10, 200, 255]); // includes \r\n and non-text bytes
  await redis.set("bin", bytes);
  assert.deepEqual(await redis.getBuffer("bin"), bytes);
});

test("a pipeline sends many commands in one write", async () => {
  const pipeline = redis.pipeline();
  for (let i = 0; i < 1000; i++) pipeline.incr("counter");
  const results = await pipeline.exec();
  assert.equal(results!.length, 1000);
  assert.deepEqual(results!.at(-1), [null, 1000]);
  assert.equal(await redis.get("counter"), "1000");
});
