// Throughput benchmark, shaped like redis-benchmark's defaults:
// 50 connections, 100,000 requests per test, random keys from 100,000,
// 3-byte values. SET and GET, each without pipelining and with 16 commands
// sent at once per connection.
//
//   npm run bench:throughput                  starts its own Pebble
//   npm run bench:throughput -- --port 6379   benchmarks a server already running
//
// Pebble runs as a separate process, and the 50 connections are spread over
// 4 worker threads, so the load generator isn't the bottleneck (one Node
// thread can't keep up with 50 busy connections). Everything still shares
// this machine's CPUs. Timing starts once every connection is open, and each
// test runs 3 times; the median is reported.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const CLIENTS = 50;
const THREADS = 4;
const REQUESTS = 100_000;
const KEYSPACE = 100_000;
const VALUE = "xxx";
const RUNS = 3;

type Job = { port: number; kind: "SET" | "GET"; pipeline: number; clients: number; requestsPerClient: number };

// ---- Worker: runs some of the connections, reports round-trip times ----

function command(words: string[]): string {
  return `*${words.length}\r\n` + words.map((w) => `$${Buffer.byteLength(w)}\r\n${w}\r\n`).join("");
}

const randomKey = () => `key:${String(Math.floor(Math.random() * KEYSPACE)).padStart(12, "0")}`;

// Every reply here starts with one of + $ : - and those bytes appear nowhere
// else (keys aren't echoed back; the value is "xxx"), so counting them counts
// replies, even when one is split across two chunks.
function countReplies(chunk: Buffer): number {
  let n = 0;
  for (const byte of chunk) if (byte === 0x2b || byte === 0x24 || byte === 0x3a || byte === 0x2d) n++;
  return n;
}

async function connect(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  socket.setNoDelay(true);
  await once(socket, "connect");
  return socket;
}

async function runConnection(socket: net.Socket, job: Job, latencies: number[]): Promise<void> {
  let received = 0;
  let waitingFor = 0;
  let wake: () => void = () => {};
  socket.on("data", (chunk) => {
    received += countReplies(chunk);
    if (received >= waitingFor) wake();
  });
  const make = job.kind === "SET" ? () => command(["SET", randomKey(), VALUE]) : () => command(["GET", randomKey()]);

  for (let done = 0; done < job.requestsPerClient; ) {
    const batch = Math.min(job.pipeline, job.requestsPerClient - done);
    waitingFor = received + batch;
    const arrived = new Promise<void>((resolve) => (wake = resolve));
    const sentAt = performance.now();
    socket.write(Array.from({ length: batch }, make).join(""));
    await arrived;
    latencies.push(performance.now() - sentAt);
    done += batch;
  }
  socket.destroy();
}

// Opens its connections, says "ready", waits for "go", then runs.
if (!isMainThread) {
  const job = workerData as Job;
  const sockets = await Promise.all(Array.from({ length: job.clients }, () => connect(job.port)));
  parentPort!.postMessage("ready");
  await once(parentPort!, "message");
  const latencies: number[] = [];
  await Promise.all(sockets.map((socket) => runConnection(socket, job, latencies)));
  parentPort!.postMessage(latencies);
}

// ---- Main thread ----

type Result = { opsPerSecond: number; p50: number; p99: number };

async function runOnce(port: number, kind: "SET" | "GET", pipeline: number): Promise<Result> {
  const requestsPerClient = Math.ceil(REQUESTS / CLIENTS);
  const workers = Array.from({ length: THREADS }, (_, t) => {
    // 50 connections over 4 threads: 13, 13, 12, 12
    const clients = Math.floor(CLIENTS / THREADS) + (t < CLIENTS % THREADS ? 1 : 0);
    return new Worker(new URL(import.meta.url), {
      workerData: { port, kind, pipeline, clients, requestsPerClient } satisfies Job,
    });
  });
  await Promise.all(workers.map((worker) => once(worker, "message"))); // all connected
  const finished = workers.map((worker) => once(worker, "message").then(([latencies]) => latencies as number[]));
  const start = performance.now();
  for (const worker of workers) worker.postMessage("go");
  const results = await Promise.all(finished);
  const seconds = (performance.now() - start) / 1000;
  const latencies = results.flat().sort((a, b) => a - b);
  return {
    opsPerSecond: Math.round((requestsPerClient * CLIENTS) / seconds),
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p99: latencies[Math.floor(latencies.length * 0.99)],
  };
}

async function runTest(port: number, kind: "SET" | "GET", pipeline: number): Promise<void> {
  const runs: Result[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await runOnce(port, kind, pipeline));
  const median = runs.sort((a, b) => a.opsPerSecond - b.opsPerSecond)[Math.floor(RUNS / 2)];
  const name = pipeline === 1 ? kind : `${kind} (pipeline ${pipeline})`;
  console.log(
    name.padEnd(22) +
      median.opsPerSecond.toLocaleString("en-US").padStart(12) +
      `${median.p50.toFixed(2)} ms`.padStart(12) +
      `${median.p99.toFixed(2)} ms`.padStart(12),
  );
}

async function startPebble(): Promise<{ proc: ChildProcess; port: number }> {
  const main = path.join(import.meta.dirname, "..", "main.js");
  const proc = spawn(process.execPath, [main, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  const port = await new Promise<number>((resolve, reject) => {
    proc.stdout!.on("data", (data) => {
      output += data;
      const match = output.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    proc.on("exit", (code) => reject(new Error(`Pebble exited (${code}): ${output}`)));
  });
  return { proc, port };
}

if (isMainThread) {
  const portArg = process.argv.indexOf("--port");
  const external = portArg !== -1 ? Number(process.argv[portArg + 1]) : null;
  const pebble = external === null ? await startPebble() : null;
  const port = external ?? pebble!.port;

  const n = (x: number) => x.toLocaleString("en-US");
  console.log(`${CLIENTS} connections on ${THREADS} threads, ${n(REQUESTS)} requests per test (median of ${RUNS}), keys from ${n(KEYSPACE)}, ${VALUE.length}-byte values`);
  console.log(`target: ${external === null ? "Pebble (started by this benchmark)" : `server on port ${port}`}\n`);
  console.log("test".padEnd(22) + "requests/sec".padStart(12) + "p50".padStart(12) + "p99".padStart(12));
  for (const pipeline of [1, 16]) {
    await runTest(port, "SET", pipeline);
    await runTest(port, "GET", pipeline);
  }
  console.log("\n(p50/p99: time for one round trip; with pipelining, for a batch of 16)");
  pebble?.proc.kill();
}
