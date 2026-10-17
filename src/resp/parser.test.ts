import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, ProtocolError } from "./parser.js";

const bytes = (s: string) => Buffer.from(s, "latin1");
const SET = "*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$7\r\nJahnavi\r\n";

test("parses a whole command", () => {
  assert.deepEqual(parse(bytes(SET)), { words: ["SET", "name", "Jahnavi"], used: SET.length });
});

test("parses a one-word command", () => {
  assert.deepEqual(parse(bytes("*1\r\n$4\r\nPING\r\n")), { words: ["PING"], used: 14 });
});

test("parses an empty word", () => {
  assert.deepEqual(parse(bytes("*2\r\n$4\r\nECHO\r\n$0\r\n\r\n")), { words: ["ECHO", ""], used: 20 });
});

test("returns null for an empty buffer", () => {
  assert.equal(parse(Buffer.alloc(0)), null);
});

test("returns null when the command is cut off at ANY point", () => {
  for (let i = 1; i < SET.length; i++) {
    assert.equal(parse(bytes(SET.slice(0, i))), null, `cut after ${i} bytes: ${JSON.stringify(SET.slice(0, i))}`);
  }
});

test("reads only the first of two commands, and says how many bytes it used", () => {
  const PING = "*1\r\n$4\r\nPING\r\n";
  const buf = bytes(SET + PING);
  const first = parse(buf);
  assert.deepEqual(first, { words: ["SET", "name", "Jahnavi"], used: SET.length });
  assert.deepEqual(parse(buf.subarray(first!.used)), { words: ["PING"], used: PING.length });
});

test("uses the $ length, so a word may contain \\r\\n", () => {
  const input = "*2\r\n$3\r\nGET\r\n$4\r\na\r\nb\r\n";
  assert.deepEqual(parse(bytes(input)), { words: ["GET", "a\r\nb"], used: input.length });
});

test("non-ASCII: $ counts bytes, and the bytes come back unchanged", () => {
  const cafe = Buffer.from("café", "utf8"); // 4 characters, 5 bytes
  const buf = Buffer.concat([bytes("*2\r\n$3\r\nGET\r\n$5\r\n"), cafe, bytes("\r\n")]);
  const result = parse(buf);
  assert.equal(result?.used, buf.length);
  assert.deepEqual(Buffer.from(result!.words[1], "latin1"), cafe);
});

test("throws ProtocolError on input that isn't a RESP array", () => {
  assert.throws(() => parse(bytes("PING\r\n")), ProtocolError);
  assert.throws(() => parse(bytes("*x\r\n")), ProtocolError);
  assert.throws(() => parse(bytes("*1\r\n$abc\r\n")), ProtocolError);
});

test("throws ProtocolError when a word isn't followed by \r\n", () => {
  assert.throws(() => parse(bytes("*1\r\n$4\r\nPINGxx")), ProtocolError);
});
