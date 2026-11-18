// Crash test: run a real Pebble process, hit it with writes, kill it without
// warning (like kill -9), restart it, and check that every write the client
// got a reply for is still there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Redis } from "ioredis";
import type { FsyncPolicy } from "./aof.js";

const MAIN = path.join(import.meta.dirname, "..", "main.js");

async function startPebble(dir: string, fsync: FsyncPolicy): Promise<{ proc: ChildProcess; port: number }> {
  const args = [MAIN, "--port", "0", "--appendonly", "yes", "--dir", dir, "--appendfsync", fsync];
  const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    proc.stdout!.on("data", (data) => {
      output += data;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    proc.on("exit", (code) => reject(new Error(`Pebble exited early (${code}): ${output}`)));
  });
  return { proc, port };
}

async function killHard(proc: ChildProcess): Promise<void> {
  const exited = once(proc, "exit");
  proc.kill("SIGKILL"); // no chance to clean up or flush anything
  await exited;
}

for (const fsync of ["always", "everysec", "no"] as const) {
  test(`kill -9 loses no acknowledged write (appendfsync ${fsync})`, { timeout: 30_000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-crash-"));
    try {
      const first = await startPebble(dir, fsync);

      // Stream INCRs in small batches; count the replies as they come back.
      const socket = net.connect(first.port, "127.0.0.1");
      socket.on("error", () => {}); // the server is about to die under us
      await once(socket, "connect");
      let acked = 0;
      socket.on("data", (chunk) => {
        for (const byte of chunk) if (byte === 0x0a) acked++; // each reply is one ":n\r\n" line
      });

      const INCR = "*2\r\n$4\r\nINCR\r\n$7\r\ncounter\r\n";
      let sent = 0;
      let ackedAtKill = 0;
      while (true) {
        socket.write(INCR.repeat(50));
        sent += 50;
        await sleep(1);
        if (acked >= 1000) {
          ackedAtKill = acked; // replies received before the kill
          await killHard(first.proc);
          break;
        }
      }
      socket.destroy();

      const second = await startPebble(dir, fsync);
      const redis = new Redis({ port: second.port, host: "127.0.0.1" });
      try {
        const counter = Number(await redis.get("counter"));
        t.diagnostic(`sent ${sent}, acknowledged before the kill ${ackedAtKill}, recovered ${counter}`);
        assert.ok(counter >= ackedAtKill, `lost acknowledged writes: counter ${counter}, acknowledged ${ackedAtKill}`);
        assert.ok(counter <= sent, `counter ${counter} is more than the ${sent} INCRs sent`);
      } finally {
        redis.disconnect();
        await killHard(second.proc);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
