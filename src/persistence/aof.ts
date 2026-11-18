// The append-only file: a diary of every command that changed data, written in
// the same RESP format clients send. Replaying it from the top rebuilds the data.
import fs from "node:fs";
import { encode } from "../resp/encoder.js";

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
