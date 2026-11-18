import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AofWriter } from "./aof.js";
import { parse } from "../resp/parser.js";
import { runCommand as run, onWrite } from "../commands/index.js";
import * as store from "../store.js";

let dir: string;
let file: string;

beforeEach(() => {
  store.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-aof-"));
  file = path.join(dir, "appendonly.aof");
});
afterEach(() => {
  onWrite(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Reads every command back out of the file with the same parser the server uses.
function readCommands(): string[][] {
  let bytes = fs.readFileSync(file);
  const commands: string[][] = [];
  let result;
  while ((result = parse(bytes)) !== null) {
    commands.push(result.words);
    bytes = bytes.subarray(result.used);
  }
  assert.equal(bytes.length, 0, "leftover bytes at the end of the file");
  return commands;
}

test("writes commands to the file in RESP format", () => {
  const aof = new AofWriter(file);
  aof.append([["SET", "name", "Jahnavi"]]);
  aof.append([["RPUSH", "l", "a", "b"], ["DEL", "x"]]);
  aof.close();

  const firstCommand = "*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$7\r\nJahnavi\r\n";
  assert.equal(fs.readFileSync(file, "latin1").slice(0, firstCommand.length), firstCommand);
  assert.deepEqual(readCommands(), [
    ["SET", "name", "Jahnavi"],
    ["RPUSH", "l", "a", "b"],
    ["DEL", "x"],
  ]);
});

test("appends to an existing file instead of replacing it", () => {
  const first = new AofWriter(file);
  first.append([["SET", "a", "1"]]);
  first.close();
  const second = new AofWriter(file);
  second.append([["SET", "b", "2"]]);
  second.close();
  assert.deepEqual(readCommands(), [
    ["SET", "a", "1"],
    ["SET", "b", "2"],
  ]);
});

test("records exactly the write commands, when hooked up with onWrite", () => {
  const aof = new AofWriter(file);
  onWrite((commands) => aof.append(commands));
  run(["SET", "k", "v"]);
  run(["GET", "k"]);
  run(["SADD", "s", "x"]);
  run(["INCR", "k"]); // error: not recorded
  aof.close();
  assert.deepEqual(readCommands(), [
    ["SET", "k", "v"],
    ["SADD", "s", "x"],
  ]);
});

test("binary values survive the round trip", () => {
  const value = Buffer.from([0, 13, 10, 255]).toString("latin1");
  const aof = new AofWriter(file);
  aof.append([["SET", "bin", value]]);
  aof.close();
  assert.deepEqual(readCommands(), [["SET", "bin", value]]);
});
