import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, type Reply } from "./encoder.js";

const resp = (reply: Reply) => encode(reply).toString("latin1");

test("simple string", () => {
  assert.equal(resp({ simple: "OK" }), "+OK\r\n");
});

test("error", () => {
  assert.equal(resp({ error: "ERR unknown command 'FOO'" }), "-ERR unknown command 'FOO'\r\n");
});

test("integer", () => {
  assert.equal(resp(42), ":42\r\n");
  assert.equal(resp(-1), ":-1\r\n");
});

test("bulk string", () => {
  assert.equal(resp("Jahnavi"), "$7\r\nJahnavi\r\n");
  assert.equal(resp(""), "$0\r\n\r\n");
});

test("null bulk string", () => {
  assert.equal(resp(null), "$-1\r\n");
});

test("array, including nested and empty", () => {
  assert.equal(resp(["a", "bc"]), "*2\r\n$1\r\na\r\n$2\r\nbc\r\n");
  assert.equal(resp([1, null, ["x"]]), "*3\r\n:1\r\n$-1\r\n*1\r\n$1\r\nx\r\n");
  assert.equal(resp([]), "*0\r\n");
});

test("non-ASCII bytes round-trip with the byte length, not the character count", () => {
  const bytes = Buffer.from("café", "utf8");            // 5 bytes, 4 characters
  const encoded = encode(bytes.toString("latin1"));
  assert.equal(encoded.toString("latin1").slice(0, 4), "$5\r\n");
  assert.deepEqual(encoded.subarray(4, 9), bytes);
});
