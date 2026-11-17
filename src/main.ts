import { createServer } from "./server.js";
import { activeExpireCycle } from "./store.js";

const HOST = "127.0.0.1";
const PORT = 6380;

createServer().listen(PORT, HOST, () => {
  console.log(`Pebble listening on ${HOST}:${PORT}`);
});

// Clean up expired keys nobody reads anymore, 10 times a second (Redis's default "hz 10").
setInterval(activeExpireCycle, 100);
