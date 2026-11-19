import type { AddressInfo } from "node:net";
import { createServer } from "./server.js";
import { activeExpireCycle } from "./store.js";
import { parseArgs } from "./config.js";
import { startPersistence } from "./persistence/startup.js";
import { configureEviction } from "./eviction.js";

const HOST = "127.0.0.1";
const config = parseArgs(process.argv.slice(2));

// Set up eviction first, so it learns about every key as data is loaded.
configureEviction({ maxmemory: config.maxmemory, policy: config.maxmemoryPolicy });

// Load the snapshot and AOF before accepting any clients.
for (const message of startPersistence(config).messages) console.log(message);

const server = createServer();
server.listen(config.port, HOST, () => {
  const { port } = server.address() as AddressInfo; // the real port, even with --port 0
  console.log(`Pebble listening on ${HOST}:${port}`);
});

// Clean up expired keys nobody reads anymore, 10 times a second (Redis's default "hz 10").
setInterval(activeExpireCycle, 100);
