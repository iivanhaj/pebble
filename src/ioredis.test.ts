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
  assert.equal(await redis.quit(), "OK");
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

test("lists", async () => {
  assert.equal(await redis.rpush("queue", "a", "b", "c"), 3);
  assert.equal(await redis.lpush("queue", "z"), 4);
  assert.deepEqual(await redis.lrange("queue", 0, -1), ["z", "a", "b", "c"]);
  assert.equal(await redis.lpop("queue"), "z");
  assert.equal(await redis.rpop("queue"), "c");
});

test("hashes, using ioredis's object helpers", async () => {
  assert.equal(await redis.hset("user:1", { name: "Jahnavi", lang: "TypeScript" }), 2);
  assert.equal(await redis.hget("user:1", "name"), "Jahnavi");
  assert.deepEqual(await redis.hgetall("user:1"), { name: "Jahnavi", lang: "TypeScript" });
  assert.equal(await redis.hdel("user:1", "lang"), 1);
});

test("sets", async () => {
  assert.equal(await redis.sadd("tags", "redis", "node", "redis"), 2);
  assert.deepEqual((await redis.smembers("tags")).sort(), ["node", "redis"]);
  assert.equal(await redis.sismember("tags", "node"), 1);
  assert.equal(await redis.srem("tags", "node"), 1);
});

test("WRONGTYPE comes back as a rejected promise", async () => {
  await redis.rpush("queue", "a");
  await assert.rejects(redis.get("queue"), /^ReplyError: WRONGTYPE/);
});

// ---- Pub/sub: a second connection subscribes, the main one publishes ----

function newClient() {
  return new Redis({ port: (server.address() as AddressInfo).port, host: "127.0.0.1" });
}

test("pub/sub: a subscriber receives what's published, in order", async () => {
  const subscriber = newClient();
  try {
    assert.equal(await subscriber.subscribe("news", "sport"), 2);
    const messages: [string, string][] = [];
    const allArrived = new Promise<void>((resolve) => {
      subscriber.on("message", (channel: string, message: string) => {
        messages.push([channel, message]);
        if (messages.length === 3) resolve();
      });
    });

    assert.equal(await redis.publish("news", "first"), 1);
    assert.equal(await redis.publish("sport", "second"), 1);
    assert.equal(await redis.publish("weather", "nobody listening"), 0);
    assert.equal(await redis.publish("news", "line one\r\nline two"), 1); // binary-safe
    await allArrived;
    assert.deepEqual(messages, [
      ["news", "first"],
      ["sport", "second"],
      ["news", "line one\r\nline two"],
    ]);
  } finally {
    subscriber.disconnect();
  }
});

test("pub/sub: unsubscribing stops delivery", async () => {
  const subscriber = newClient();
  try {
    await subscriber.subscribe("news");
    assert.equal(await redis.publish("news", "x"), 1);
    await subscriber.unsubscribe("news");
    assert.equal(await redis.publish("news", "x"), 0);
  } finally {
    subscriber.disconnect();
  }
});

test("pub/sub: a subscriber that disconnects is removed from its channels", async () => {
  const subscriber = newClient();
  await subscriber.subscribe("news");
  assert.equal(await redis.publish("news", "x"), 1);
  subscriber.disconnect();
  // The server notices the closed socket asynchronously; give it a moment.
  let receivers = 1;
  for (let attempt = 0; attempt < 50 && receivers > 0; attempt++) {
    await sleep(10);
    receivers = await redis.publish("news", "x");
  }
  assert.equal(receivers, 0);
});

// ---- Transactions ----

test("transactions: MULTI/EXEC through ioredis", async () => {
  const results = await redis.multi().set("a", "1").incr("a").rpush("l", "x").exec();
  assert.deepEqual(results, [
    [null, "OK"],
    [null, 2],
    [null, 1],
  ]);
});

test("transactions: WATCH makes EXEC return null when another client changed the key", async () => {
  const other = newClient();
  try {
    await redis.set("balance", "100");
    await redis.watch("balance");
    await other.set("balance", "50");
    const results = await redis.multi().set("balance", "90").exec();
    assert.equal(results, null);
    assert.equal(await redis.get("balance"), "50");
  } finally {
    other.disconnect();
  }
});

test("transactions: a queuing error makes the whole EXEC fail", async () => {
  await assert.rejects(redis.multi().set("a", "1").call("NOPE").exec(), /EXECABORT/);
  assert.equal(await redis.exists("a"), 0);
});
