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
