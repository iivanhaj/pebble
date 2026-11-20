// The append-only file: a diary of every command that changed data, written in
// the same RESP format clients send. Replaying it from the top rebuilds the data.
import fs from "node:fs";
import { encode } from "../resp/encoder.js";
import { parse, ProtocolError } from "../resp/parser.js";
import { runCommand } from "../commands/index.js";
import { detachedClient } from "../client.js";
import * as store from "../store.js";

export type LoadResult = { commands: number; truncatedBytes: number };

// Replays the AOF into the store. Call it before the AOF writer is hooked up to
// onWrite, or replayed commands would be written to the file a second time.
//
// If the file ends partway through a command (the server died mid-write), that
// broken tail is cut off and loading carries on, like Redis's default
// "aof-load-truncated yes". The same goes for a transaction whose MULTI was
// written but not its EXEC: the whole transaction is cut off, so it's either
// all there or not at all. Anything else unreadable throws: better to refuse
// to start than to guess.
//
// `from` skips the start of the file: everything before it is already in the
// snapshot that was loaded first.
export function loadAof(path: string, from = 0): LoadResult {
  if (!fs.existsSync(path)) return { commands: 0, truncatedBytes: 0 };
  const bytes = fs.readFileSync(path);
  if (from > bytes.length) {
    throw new Error(`${path} is shorter (${bytes.length} bytes) than the snapshot expects (${from} bytes)`);
  }

  let pos = from;
  let commands = 0;
  // One client for the whole file, so MULTI ... EXEC replays as a transaction.
  const client = detachedClient();
  let multiStart = { pos: 0, commands: 0 }; // where the open MULTI began, if any
  store.setLoading(true);
  try {
    while (pos < bytes.length) {
      let result;
      try {
        result = parse(bytes.subarray(pos));
      } catch (err) {
        if (err instanceof ProtocolError) {
          throw new Error(`Bad AOF ${path} at byte ${pos}: ${err.message}`);
        }
        throw err;
      }
      if (result === null) break; // a half-written command at the end
      if (result.words[0].toUpperCase() === "MULTI") multiStart = { pos, commands };
      const reply = runCommand(result.words, client);
      if (reply !== null && typeof reply === "object" && "error" in reply) {
        throw new Error(`Bad AOF ${path} at byte ${pos}: ${result.words[0]} failed: ${reply.error}`);
      }
      pos += result.used;
      commands++;
    }
  } finally {
    store.setLoading(false);
  }

  if (client.transaction) {
    // The file ends inside a transaction: drop all of it. Its commands were
    // only queued, never run, so nothing needs undoing.
    pos = multiStart.pos;
    commands = multiStart.commands;
  }
  const truncatedBytes = bytes.length - pos;
  if (truncatedBytes > 0) fs.truncateSync(path, pos);
  return { commands, truncatedBytes };
}

// Writing to a file only puts the bytes in the OS's memory; the OS copies them
// to the disk later. fsync forces that copy now. It's slow (it waits for the
// disk), so like Redis there are three policies:
//   always:   fsync after every write. Nothing is lost even if the power fails.
//   everysec: fsync once a second, off the main thread. Lose at most ~1 second.
//   no:       never fsync; the OS decides when (around 30 seconds on Linux).
// If only Pebble crashes, nothing is lost under any policy: the bytes are
// already in the OS's memory and still reach the disk. fsync matters when the
// whole machine goes down.
export type FsyncPolicy = "always" | "everysec" | "no";

export class AofWriter {
  private fd: number;
  private timer: NodeJS.Timeout | undefined;
  private unsynced = false; // written since the last fsync?
  private syncing = false; // an everysec fsync is still running
  size: number; // bytes in the file; a snapshot records this so loading can skip what it already has

  constructor(path: string, private policy: FsyncPolicy = "everysec") {
    this.fd = fs.openSync(path, "a"); // "a": every write goes to the end of the file
    this.size = fs.fstatSync(this.fd).size;
    if (policy === "everysec") {
      this.timer = setInterval(() => this.backgroundSync(), 1000);
      this.timer.unref(); // don't keep the process alive just for this timer
    }
  }

  // Writes the commands before returning, so the client's reply is only sent
  // once its change is in the file.
  append(commands: string[][]): void {
    const bytes = Buffer.concat(commands.map((words) => encode(words)));
    let written = 0;
    while (written < bytes.length) {
      written += fs.writeSync(this.fd, bytes, written);
    }
    this.size += bytes.length;
    if (this.policy === "always") fs.fsyncSync(this.fd);
    else this.unsynced = true;
  }

  close(): void {
    clearInterval(this.timer);
    if (this.unsynced && this.policy !== "no") fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
  }

  // fs.fsync (not fsyncSync) runs on Node's thread pool, so the event loop keeps
  // serving clients while the disk catches up. Redis uses a background thread
  // for the same reason.
  private backgroundSync(): void {
    if (!this.unsynced || this.syncing) return;
    this.unsynced = false;
    this.syncing = true;
    fs.fsync(this.fd, () => {
      this.syncing = false;
    });
  }
}
