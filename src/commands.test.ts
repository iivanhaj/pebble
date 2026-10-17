import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "./commands.js";
import { store } from "./store.js";

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
