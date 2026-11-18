// Snapshots: the whole store saved to one compact file at one moment.
//
// File format (numbers are big-endian; text is latin1, one byte per character):
//
//   "PEBBLE01"                  magic + format version (8 bytes)
//   aofOffset   int64           AOF size when the snapshot was taken, -1 if no AOF
//   savedAt     int64           unix time in ms
//   then one record per key:
//     type      uint8           0 string, 1 list, 2 hash, 3 set
//     expiresAt int64           unix time in ms, -1 if no timeout
//     key       string          (uint32 length + bytes)
//     value     string                         for a string
//               count + count strings          for a list or set
//               count + count field/value pairs for a hash
//   0xFF                        end of records
//   crc32       uint32          checksum of everything before it
import fs from "node:fs";
import zlib from "node:zlib";
import { Deque } from "../deque.js";
import * as store from "../store.js";

const MAGIC = "PEBBLE01";
const STRING = 0;
const LIST = 1;
const HASH = 2;
const SET = 3;
const END = 0xff;

export type SnapshotInfo = { keys: number; aofOffset: number; savedAt: number };

// ---- Saving ----

export function encodeSnapshot(aofOffset: number): Buffer {
  const out = new ByteWriter();
  out.raw(MAGIC);
  out.int64(aofOffset);
  out.int64(Date.now());

  for (const [key, value, expiresAt] of store.entries()) {
    if (typeof value === "string") {
      out.uint8(STRING);
      out.int64(expiresAt ?? -1);
      out.string(key);
      out.string(value);
    } else if (value instanceof Deque) {
      out.uint8(LIST);
      out.int64(expiresAt ?? -1);
      out.string(key);
      out.uint32(value.length);
      for (let i = 0; i < value.length; i++) out.string(value.at(i)!);
    } else if (value instanceof Map) {
      out.uint8(HASH);
      out.int64(expiresAt ?? -1);
      out.string(key);
      out.uint32(value.size);
      for (const [field, fieldValue] of value) {
        out.string(field);
        out.string(fieldValue);
      }
    } else {
      out.uint8(SET);
      out.int64(expiresAt ?? -1);
      out.string(key);
      out.uint32(value.size);
      for (const member of value) out.string(member);
    }
  }

  out.uint8(END);
  const body = out.bytes();
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([body, checksum]);
}

// Writes the snapshot so that a crash at any moment leaves either the old file
// or the new one, never half of one: write to a temporary file, force it onto
// the disk, then rename it over the old file (a rename replaces in one step).
export function saveSnapshot(path: string, aofOffset: number): number {
  const bytes = encodeSnapshot(aofOffset);
  const temporary = `${path}.tmp`;
  const fd = fs.openSync(temporary, "w");
  try {
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, path);
  return bytes.length;
}

// ---- Loading ----

// Checks the file, then puts its keys into the store. Throws if the file is
// damaged in any way, rather than load something wrong.
export function loadSnapshot(path: string): SnapshotInfo {
  const bytes = fs.readFileSync(path);
  if (bytes.length < MAGIC.length + 4 || bytes.toString("latin1", 0, MAGIC.length) !== MAGIC) {
    throw new Error(`${path} is not a Pebble snapshot`);
  }
  const body = bytes.subarray(0, bytes.length - 4);
  if (zlib.crc32(body) !== bytes.readUInt32BE(bytes.length - 4)) {
    throw new Error(`${path} is damaged: checksum mismatch`);
  }

  const input = new ByteReader(body, path);
  input.skip(MAGIC.length);
  const aofOffset = input.int64();
  const savedAt = input.int64();

  let keys = 0;
  for (let type = input.uint8(); type !== END; type = input.uint8()) {
    const expiresAt = input.int64();
    const key = input.string();
    store.set(key, readValue(input, type));
    if (expiresAt !== -1) store.setExpiry(key, expiresAt);
    keys++;
  }
  if (!input.atEnd()) throw new Error(`${path} is damaged: data after the end marker`);
  return { keys, aofOffset, savedAt };
}

function readValue(input: ByteReader, type: number): store.Value {
  switch (type) {
    case STRING:
      return input.string();
    case LIST: {
      const list = new Deque<string>();
      for (let n = input.uint32(); n > 0; n--) list.pushBack(input.string());
      return list;
    }
    case HASH: {
      const hash = new Map<string, string>();
      for (let n = input.uint32(); n > 0; n--) hash.set(input.string(), input.string());
      return hash;
    }
    case SET: {
      const set = new Set<string>();
      for (let n = input.uint32(); n > 0; n--) set.add(input.string());
      return set;
    }
    default:
      throw new Error(`unknown value type ${type}`);
  }
}

// ---- Byte helpers ----

// Appends to one buffer that doubles in size when full, instead of creating
// lots of small buffers (this runs once per key, so it needs to be quick).
class ByteWriter {
  private buffer = Buffer.alloc(64 * 1024);
  private length = 0;

  uint8(n: number): void {
    this.reserve(1);
    this.buffer.writeUInt8(n, this.length);
    this.length += 1;
  }

  uint32(n: number): void {
    this.reserve(4);
    this.buffer.writeUInt32BE(n, this.length);
    this.length += 4;
  }

  int64(n: number): void {
    this.reserve(8);
    this.buffer.writeBigInt64BE(BigInt(n), this.length);
    this.length += 8;
  }

  string(s: string): void {
    this.uint32(s.length); // latin1: one byte per character
    this.raw(s);
  }

  raw(s: string): void {
    this.reserve(s.length);
    this.length += this.buffer.write(s, this.length, "latin1");
  }

  bytes(): Buffer {
    return this.buffer.subarray(0, this.length);
  }

  private reserve(needed: number): void {
    if (this.length + needed <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + needed) size *= 2;
    const bigger = Buffer.alloc(size);
    this.buffer.copy(bigger, 0, 0, this.length);
    this.buffer = bigger;
  }
}

class ByteReader {
  private pos = 0;

  constructor(private buffer: Buffer, private path: string) {}

  uint8(): number {
    this.need(1);
    return this.buffer.readUInt8(this.pos++);
  }

  uint32(): number {
    this.need(4);
    const n = this.buffer.readUInt32BE(this.pos);
    this.pos += 4;
    return n;
  }

  int64(): number {
    this.need(8);
    const n = Number(this.buffer.readBigInt64BE(this.pos));
    this.pos += 8;
    return n;
  }

  string(): string {
    const length = this.uint32();
    this.need(length);
    const s = this.buffer.toString("latin1", this.pos, this.pos + length);
    this.pos += length;
    return s;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  atEnd(): boolean {
    return this.pos === this.buffer.length;
  }

  private need(n: number): void {
    if (this.pos + n > this.buffer.length) throw new Error(`${this.path} is damaged: it ends too early`);
  }
}
