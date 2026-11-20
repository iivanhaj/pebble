import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./commands/index.js";
import { createClient } from "./client.js";
import * as store from "./store.js";

beforeEach(() => store.clear());

function newClient() {
  const client = createClient(() => {});
  return (...words: string[]) => runCommand(words, client);
}

const OK = { simple: "OK" };
const QUEUED = { simple: "QUEUED" };

// ---- MULTI / EXEC / DISCARD ----

test("commands are queued, then EXEC runs them all and returns every reply", () => {
  const alice = newClient();
  const bob = newClient();
  assert.deepEqual(alice("MULTI"), OK);
  assert.deepEqual(alice("SET", "a", "1"), QUEUED);
  assert.deepEqual(alice("INCR", "a"), QUEUED);
  assert.deepEqual(alice("RPUSH", "l", "x", "y"), QUEUED);
  assert.deepEqual(alice("GET", "a"), QUEUED);

  assert.equal(bob("GET", "a"), null); // nothing has run yet

  assert.deepEqual(alice("EXEC"), [OK, 2n, 2, "2"]);
  assert.equal(bob("GET", "a"), "2");
  assert.deepEqual(bob("LRANGE", "l", "0", "-1"), ["x", "y"]);
});

test("queued commands see the data as it is at EXEC time", () => {
  const alice = newClient();
  const bob = newClient();
  alice("MULTI");
  alice("INCR", "n");
  bob("SET", "n", "10"); // between queuing and EXEC
  assert.deepEqual(alice("EXEC"), [11n]);
});

test("an empty transaction returns an empty array", () => {
  const alice = newClient();
  alice("MULTI");
  assert.deepEqual(alice("EXEC"), []);
});

test("DISCARD throws the queue away", () => {
  const alice = newClient();
  alice("MULTI");
  alice("SET", "a", "1");
  assert.deepEqual(alice("DISCARD"), OK);
  assert.equal(alice("GET", "a"), null); // runs normally again: not queued
});

test("EXEC and DISCARD without MULTI, and nested MULTI", () => {
  const alice = newClient();
  assert.deepEqual(alice("EXEC"), { error: "ERR EXEC without MULTI" });
  assert.deepEqual(alice("DISCARD"), { error: "ERR DISCARD without MULTI" });
  alice("MULTI");
  assert.deepEqual(alice("MULTI"), { error: "ERR MULTI calls can not be nested" });
  alice("SET", "a", "1");
  assert.deepEqual(alice("EXEC"), [OK]); // the nested MULTI didn't spoil the transaction
});

test("a command rejected while queuing aborts the whole transaction", () => {
  const alice = newClient();
  alice("MULTI");
  alice("SET", "a", "1");
  assert.deepEqual(alice("NOPE"), { error: "ERR unknown command 'NOPE', with args beginning with: " });
  assert.deepEqual(alice("GET"), { error: "ERR wrong number of arguments for 'get' command" });
  alice("SET", "b", "2");
  assert.deepEqual(alice("EXEC"), { error: "EXECABORT Transaction discarded because of previous errors." });
  assert.equal(alice("EXISTS", "a", "b"), 0); // none of it ran
});

test("an error while running doesn't stop the other commands", () => {
  const alice = newClient();
  alice("SET", "s", "a string");
  alice("MULTI");
  alice("SET", "a", "1");
  alice("LPUSH", "s", "x"); // WRONGTYPE, but only found out when it runs
  alice("SET", "b", "2");
  assert.deepEqual(alice("EXEC"), [
    OK,
    { error: "WRONGTYPE Operation against a key holding the wrong kind of value" },
    OK,
  ]);
  assert.equal(alice("EXISTS", "a", "b"), 2);
});

test("each client has its own transaction", () => {
  const alice = newClient();
  const bob = newClient();
  alice("MULTI");
  assert.deepEqual(bob("SET", "k", "bob"), OK); // bob isn't in a transaction
  alice("SET", "k", "alice");
  alice("EXEC");
  assert.equal(bob("GET", "k"), "alice");
});

// ---- WATCH ----

const ABORTED = { nullArray: true }; // EXEC's nil reply

test("if a watched key changes, EXEC returns nil and runs nothing", () => {
  const alice = newClient();
  const bob = newClient();
  alice("SET", "balance", "100");
  assert.deepEqual(alice("WATCH", "balance"), OK);
  bob("SET", "balance", "50"); // bob gets there first
  alice("MULTI");
  alice("SET", "balance", "90");
  alice("SET", "audit", "alice paid 10");
  assert.deepEqual(alice("EXEC"), ABORTED);
  assert.equal(alice("GET", "balance"), "50");
  assert.equal(alice("EXISTS", "audit"), 0);
});

test("if nothing changed, EXEC runs as usual", () => {
  const alice = newClient();
  const bob = newClient();
  alice("SET", "balance", "100");
  alice("WATCH", "balance");
  bob("GET", "balance"); // reading doesn't count
  bob("SET", "other", "x"); // nor does changing another key
  alice("MULTI");
  alice("SET", "balance", "90");
  assert.deepEqual(alice("EXEC"), [OK]);
});

test("every kind of change counts: in-place list changes, DEL, EXPIRE, expiry, eviction-style removal", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const changes: [string, () => void][] = [
    ["LPUSH onto a watched list", () => runCommand(["LPUSH", "k", "x"])],
    ["HSET a field", () => runCommand(["HSET", "h", "f", "2"])],
    ["DEL", () => runCommand(["DEL", "k"])],
    ["EXPIRE", () => runCommand(["EXPIRE", "k", "100"])],
    ["INCR", () => runCommand(["INCR", "n"])],
  ];
  for (const [name, change] of changes) {
    store.clear();
    runCommand(["RPUSH", "k", "a"]);
    runCommand(["HSET", "h", "f", "1"]);
    runCommand(["SET", "n", "1"]);
    const alice = newClient();
    alice("WATCH", "k", "h", "n");
    change();
    alice("MULTI");
    alice("PING");
    assert.deepEqual(alice("EXEC"), ABORTED, name);
  }

  // A watched key that expires counts as changed too.
  store.clear();
  const alice = newClient();
  alice("SET", "session", "abc", "PX", "100");
  alice("WATCH", "session");
  t.mock.timers.tick(101);
  alice("GET", "session"); // lazy expiry removes it
  alice("MULTI");
  alice("PING");
  assert.deepEqual(alice("EXEC"), ABORTED);
});

test("EXEC, DISCARD and UNWATCH all end the watch", () => {
  const alice = newClient();
  const bob = newClient();
  for (const end of [["EXEC"], ["DISCARD"], ["UNWATCH"]]) {
    alice("WATCH", "k");
    if (end[0] !== "UNWATCH") alice("MULTI");
    alice(...end);
    bob("SET", "k", "changed after the watch ended");
    alice("MULTI");
    alice("PING");
    assert.deepEqual(alice("EXEC"), [{ simple: "PONG" }], `after ${end[0]}`);
  }
});

test("an aborted EXEC also ends the watch, so the retry starts fresh", () => {
  const alice = newClient();
  const bob = newClient();
  alice("WATCH", "k");
  bob("SET", "k", "1");
  alice("MULTI");
  assert.deepEqual(alice("EXEC"), ABORTED);
  alice("MULTI");
  alice("PING");
  assert.deepEqual(alice("EXEC"), [{ simple: "PONG" }]);
});

test("WATCH inside MULTI is refused", () => {
  const alice = newClient();
  alice("MULTI");
  assert.deepEqual(alice("WATCH", "k"), { error: "ERR WATCH inside MULTI is not allowed" });
});

test("optimistic locking: two clients doubling a counter, the loser retries", () => {
  // Each client wants to double "n" with a read-compute-write that INCR can't do.
  // Returns how many attempts it took.
  const doubleWithWatch = (client: ReturnType<typeof newClient>, interfere?: () => void): number => {
    for (let attempt = 1; ; attempt++) {
      client("WATCH", "n");
      const value = Number(client("GET", "n"));
      if (attempt === 1) interfere?.(); // the other client sneaks in between our read and write
      client("MULTI");
      client("SET", "n", String(value * 2));
      if (Array.isArray(client("EXEC"))) return attempt; // ran; a refused EXEC is { nullArray: true }
    }
  };
  const alice = newClient();
  const bob = newClient();
  runCommand(["SET", "n", "3"]);
  const aliceAttempts = doubleWithWatch(alice, () => assert.equal(doubleWithWatch(bob), 1));
  // Bob doubled 3 -> 6 in the middle of alice's first try. Alice's EXEC was
  // refused, she retried from 6, and got 12. Without WATCH she'd have written
  // 3 * 2 = 6 over bob's 6, and one doubling would have been lost.
  assert.equal(aliceAttempts, 2);
  assert.equal(runCommand(["GET", "n"]), "12");
});
