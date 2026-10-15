import net from "node:net";

const HOST = "127.0.0.1";
const PORT = 6380;

const server = net.createServer((socket) => {
  socket.on("data", () => {
    // No RESP parsing yet: answer every chunk of input with PONG.
    socket.write("+PONG\r\n");
  });
  socket.on("error", () => {
    // Client went away mid-write (e.g. connection reset); nothing to do yet.
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Pebble listening on ${HOST}:${PORT}`);
});
