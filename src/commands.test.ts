import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./commands/index.js";
import * as store from "./store.js";

beforeEach(() => store.clear());

test("PING", () => {
  assert.deepEqual(runCommand(["PING"]), { simple: "PONG" });
  assert.equal(runCommand(["PING", "hi"]), "hi");
});

test("ECHO", () => {
  assert.equal(runCommand(["ECHO", "hello"]), "hello");
});

test("SET then GET; GET on a missing key is null", () => {
  assert.deepEqual(runCommand(["SET", "name", "Jahnavi"]), { simple: "OK" });
  assert.equal(runCommand(["GET", "name"]), "Jahnavi");
  assert.equal(runCommand(["GET", "nope"]), null);
});

test("SET overwrites", () => {
  runCommand(["SET", "k", "1"]);
  runCommand(["SET", "k", "2"]);
  assert.equal(runCommand(["GET", "k"]), "2");
});

test("DEL returns how many keys it removed", () => {
  runCommand(["SET", "a", "1"]);
  runCommand(["SET", "b", "2"]);
  assert.equal(runCommand(["DEL", "a", "b", "missing"]), 2);
  assert.equal(runCommand(["GET", "a"]), null);
});

test("EXISTS counts keys, including repeats", () => {
  runCommand(["SET", "a", "1"]);
  assert.equal(runCommand(["EXISTS", "a", "a", "missing"]), 2);
});

test("command names are case-insensitive", () => {
  assert.deepEqual(runCommand(["set", "k", "v"]), { simple: "OK" });
  assert.equal(runCommand(["gEt", "k"]), "v");
});

test("unknown command", () => {
  assert.deepEqual(runCommand(["FOO", "x"]), {
    error: "ERR unknown command 'FOO', with args beginning with: 'x'",
  });
  assert.deepEqual(runCommand(["toString"]), {
    error: "ERR unknown command 'toString', with args beginning with: ",
  });
});

test("wrong number of arguments", () => {
  const error = (name: string) => ({ error: `ERR wrong number of arguments for '${name}' command` });
  assert.deepEqual(runCommand(["GET"]), error("get"));
  assert.deepEqual(runCommand(["SET", "k"]), error("set"));
  assert.deepEqual(runCommand(["DEL"]), error("del"));
  assert.deepEqual(runCommand(["PING", "a", "b"]), error("ping"));
});

test("INCR and DECR; a missing key starts at 0", () => {
  assert.equal(runCommand(["INCR", "n"]), 1n);
  assert.equal(runCommand(["INCR", "n"]), 2n);
  assert.equal(runCommand(["DECR", "n"]), 1n);
  assert.equal(runCommand(["GET", "n"]), "1"); // stored as a string, like Redis
  assert.equal(runCommand(["DECR", "fresh"]), -1n);
});

test("INCR on a value that isn't a plain integer", () => {
  const error = { error: "ERR value is not an integer or out of range" };
  for (const value of ["abc", "1.5", " 1", "+1", "01", "", "99999999999999999999"]) {
    runCommand(["SET", "k", value]);
    assert.deepEqual(runCommand(["INCR", "k"]), error, `value ${JSON.stringify(value)}`);
  }
});

test("INCR works across the full 64-bit range and refuses to overflow", () => {
  runCommand(["SET", "k", "9223372036854775806"]); // 2^63 - 2, too big for a JS number to hold exactly
  assert.equal(runCommand(["INCR", "k"]), 9223372036854775807n);
  assert.deepEqual(runCommand(["INCR", "k"]), { error: "ERR increment or decrement would overflow" });
  runCommand(["SET", "k", "-9223372036854775808"]);
  assert.deepEqual(runCommand(["DECR", "k"]), { error: "ERR increment or decrement would overflow" });
});

test("INCR keeps the key's timeout", () => {
  runCommand(["SET", "k", "1", "EX", "100"]);
  runCommand(["INCR", "k"]);
  assert.equal(runCommand(["TTL", "k"]), 100);
});

test("MSET sets many keys; MGET returns null for missing ones", () => {
  assert.deepEqual(runCommand(["MSET", "a", "1", "b", "2"]), { simple: "OK" });
  assert.deepEqual(runCommand(["MGET", "a", "missing", "b"]), ["1", null, "2"]);
});

test("MSET needs key-value pairs", () => {
  assert.deepEqual(runCommand(["MSET", "a", "1", "b"]), { error: "ERR wrong number of arguments for 'mset' command" });
  assert.equal(runCommand(["GET", "a"]), null); // nothing set
});

test("INFO reports sections, and can return just one", () => {
  runCommand(["SET", "a", "1"]);
  runCommand(["SET", "b", "2", "EX", "100"]);
  const all = runCommand(["INFO"]) as string;
  assert.match(all, /^# Server\r\npebble_version:/);
  assert.match(all, /\r\n# Persistence\r\nloading:0\r\n/);
  assert.match(all, /\r\n# Keyspace\r\ndb0:keys=2,expires=1,avg_ttl=0\r\n$/);
  assert.equal(runCommand(["INFO", "persistence"]), "# Persistence\r\nloading:0\r\n");
  assert.equal(runCommand(["INFO", "nonsense"]), "");
});
