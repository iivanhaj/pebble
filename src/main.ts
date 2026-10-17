import { createServer } from "./server.js";

const HOST = "127.0.0.1";
const PORT = 6380;

createServer().listen(PORT, HOST, () => {
  console.log(`Pebble listening on ${HOST}:${PORT}`);
});
