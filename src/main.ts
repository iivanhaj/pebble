import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "./server.js";
import { activeExpireCycle } from "./store.js";
import { onWrite } from "./commands/index.js";
import { parseArgs } from "./config.js";
import { AofWriter, loadAof } from "./persistence/aof.js";

const HOST = "127.0.0.1";
const config = parseArgs(process.argv.slice(2));

if (config.appendonly) {
  const aofPath = path.join(config.dir, config.appendfilename);

  // First rebuild the data from the file, THEN start recording new writes.
  const loaded = loadAof(aofPath);
  console.log(`Loaded ${loaded.commands} commands from ${aofPath}`);
  if (loaded.truncatedBytes > 0) {
    console.warn(`The AOF ended with a half-written command; cut off its last ${loaded.truncatedBytes} bytes`);
  }

  const aof = new AofWriter(aofPath, config.appendfsync);
  onWrite((commands) => aof.append(commands));
  console.log(`Recording writes to ${aofPath} (appendfsync ${config.appendfsync})`);
}

const server = createServer();
server.listen(config.port, HOST, () => {
  const { port } = server.address() as AddressInfo; // the real port, even with --port 0
  console.log(`Pebble listening on ${HOST}:${port}`);
});

// Clean up expired keys nobody reads anymore, 10 times a second (Redis's default "hz 10").
setInterval(activeExpireCycle, 100);
