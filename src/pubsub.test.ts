import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand, onWrite } from "./commands/index.js";
import { encode, type Reply } from "./resp/encoder.js";
import type { Client } from "./client.js";
import * as pubsub from "./pubsub.js";
import * as store from "./store.js";

beforeEach(() => {
  store.clear();
  pubsub.clear();
});

// A pretend connection that records everything sent to it outside its own replies.
function fakeClient() {
  const received: Reply[] = [];
  const client: Client = { send: (reply) => received.push(reply), closeAfterReply: false, subscriptions: new Set() };
  const run = (...words: string[]) => runCommand(words, client);
  return { client, received, run };
}

test("SUBSCRIBE confirms each channel with a running count", () => {
  const alice = fakeClient();
  assert.deepEqual(alice.run("SUBSCRIBE", "news", "sport"), {
    sequence: [
      ["subscribe", "news", 1],
      ["subscribe", "sport", 2],
    ],
  });
  // On the wire: two separate replies, exactly as Redis sends them.
  assert.equal(
    encode(alice.run("SUBSCRIBE", "weather")).toString(),
    "*3\r\n$9\r\nsubscribe\r\n$7\r\nweather\r\n:3\r\n",
  );
});

test("PUBLISH reaches every subscriber of that channel, and only them", () => {
  const alice = fakeClient();
  const bob = fakeClient();
  const carol = fakeClient();
  const publisher = fakeClient();
  alice.run("SUBSCRIBE", "news");
  bob.run("SUBSCRIBE", "news", "sport");
  carol.run("SUBSCRIBE", "sport");

  assert.equal(publisher.run("PUBLISH", "news", "hello"), 2);
  assert.deepEqual(alice.received, [["message", "news", "hello"]]);
  assert.deepEqual(bob.received, [["message", "news", "hello"]]);
  assert.deepEqual(carol.received, []);
  assert.deepEqual(publisher.received, []);
});

test("PUBLISH to a channel nobody listens to reaches no one", () => {
  const publisher = fakeClient();
  assert.equal(publisher.run("PUBLISH", "empty", "hello?"), 0);
});

test("messages arrive in the order they were published", () => {
  const alice = fakeClient();
  alice.run("SUBSCRIBE", "c");
  for (const n of ["1", "2", "3"]) runCommand(["PUBLISH", "c", n]);
  assert.deepEqual(alice.received, [
    ["message", "c", "1"],
    ["message", "c", "2"],
    ["message", "c", "3"],
  ]);
});

test("UNSUBSCRIBE from some channels, then all of them", () => {
  const alice = fakeClient();
  alice.run("SUBSCRIBE", "a", "b", "c");
  assert.deepEqual(alice.run("UNSUBSCRIBE", "b"), { sequence: [["unsubscribe", "b", 2]] });
  assert.equal(runCommand(["PUBLISH", "b", "x"]), 0);
  assert.deepEqual(alice.run("UNSUBSCRIBE"), {
    sequence: [
      ["unsubscribe", "a", 1],
      ["unsubscribe", "c", 0],
    ],
  });
  assert.equal(pubsub.channelCount(), 0); // empty channels are removed
});

test("UNSUBSCRIBE when not subscribed to anything", () => {
  const alice = fakeClient();
  assert.deepEqual(alice.run("UNSUBSCRIBE"), { sequence: [["unsubscribe", null, 0]] });
});

test("subscribed mode: only (UN)SUBSCRIBE, PING and QUIT are allowed", () => {
  const alice = fakeClient();
  alice.run("SUBSCRIBE", "news");
  assert.deepEqual(alice.run("GET", "k"), {
    error: "ERR Can't execute 'get': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context",
  });
  assert.match((alice.run("PUBLISH", "news", "x") as { error: string }).error, /Can't execute 'publish'/);
  assert.deepEqual(alice.run("PING"), ["pong", ""]);
  assert.deepEqual(alice.run("PING", "hi"), ["pong", "hi"]);

  alice.run("UNSUBSCRIBE");
  assert.equal(alice.run("GET", "k"), null); // normal again
  assert.deepEqual(alice.run("PING"), { simple: "PONG" });
});

test("a disconnecting client is removed from every channel", () => {
  const alice = fakeClient();
  alice.run("SUBSCRIBE", "a", "b");
  pubsub.unsubscribeAll(alice.client); // what the connection does on close
  assert.equal(runCommand(["PUBLISH", "a", "x"]), 0);
  assert.equal(pubsub.channelCount(), 0);
  assert.deepEqual(alice.received, []);
});

test("PUBLISH isn't recorded in the AOF and doesn't touch the data", () => {
  const recorded: string[][] = [];
  onWrite((commands) => recorded.push(...commands));
  try {
    runCommand(["PUBLISH", "c", "x"]);
  } finally {
    onWrite(null);
  }
  assert.deepEqual(recorded, []);
  assert.equal(store.size(), 0);
});

test("INFO counts channels with listeners", () => {
  const alice = fakeClient();
  alice.run("SUBSCRIBE", "a", "b");
  assert.match(runCommand(["INFO", "stats"]) as string, /pubsub_channels:2\r\n/);
});
