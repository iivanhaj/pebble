// The append-only file: a diary of every command that changed data, written in
// the same RESP format clients send. Replaying it from the top rebuilds the data.
import fs from "node:fs";
import { encode } from "../resp/encoder.js";
import { parse, ProtocolError } from "../resp/parser.js";
import { runCommand } from "../commands/index.js";
import * as store from "../store.js";

export type LoadResult = { commands: number; truncatedBytes: number };

// Replays the AOF into the store. Call it before the AOF writer is hooked up to
// onWrite, or replayed commands would be written to the file a second time.
//
// If the file ends partway through a command (the server died mid-write), that
// broken tail is cut off and loading carries on, like Redis's default
// "aof-load-truncated yes". Anything else unreadable throws: better to refuse
// to start than to guess.
export function loadAof(path: string): LoadResult {
  if (!fs.existsSync(path)) return { commands: 0, truncatedBytes: 0 };
  const bytes = fs.readFileSync(path);

  let pos = 0;
  let commands = 0;
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
      const reply = runCommand(result.words);
      if (reply !== null && typeof reply === "object" && "error" in reply) {
        throw new Error(`Bad AOF ${path} at byte ${pos}: ${result.words[0]} failed: ${reply.error}`);
      }
      pos += result.used;
      commands++;
    }
  } finally {
    store.setLoading(false);
  }

  const truncatedBytes = bytes.length - pos;
  if (truncatedBytes > 0) fs.truncateSync(path, pos);
  return { commands, truncatedBytes };
}

export class AofWriter {
  private fd: number;

  constructor(path: string) {
    this.fd = fs.openSync(path, "a"); // "a": every write goes to the end of the file
  }

  // Writes the commands before returning, so the client's reply is only sent
  // once its change is in the file (in the OS's buffers; see fsync).
  append(commands: string[][]): void {
    const bytes = Buffer.concat(commands.map((words) => encode(words)));
    let written = 0;
    while (written < bytes.length) {
      written += fs.writeSync(this.fd, bytes, written);
    }
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
