// End to end: a real TCP client talking to a real server, like redis-cli would.
import { test } from "node:test";
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "./server.js";

async function connect() {
  const server = createServer();
  server.listen(0, "127.0.0.1"); // port 0: the OS picks a free port
  await once(server, "listening");
  const client = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
  await once(client, "connect");

  let received = "";
  client.on("data", (data) => (received += data.toString("latin1")));
  // Resolves once at least `length` bytes have come back.
  const receive = (length: number) =>
    new Promise<string>((resolve) => {
      const check = () => (received.length >= length ? resolve(received) : client.once("data", check));
      check();
    });

  const close = () => {
    client.destroy();
    server.close();
  };
  return { client, receive, close };
}

test("SET arriving in pieces, then GET and PING in one chunk", async () => {
  const { client, receive, close } = await connect();

  for (const piece of ["*3\r\n$3\r\nSE", "T\r\n$4\r\nna", "me\r\n$7\r\nJahnavi\r\n"]) {
    client.write(piece);
    await sleep(10); // make sure each piece arrives as its own chunk
  }
  client.write("*2\r\n$3\r\nGET\r\n$4\r\nname\r\n*1\r\n$4\r\nPING\r\n");

  const expected = "+OK\r\n$7\r\nJahnavi\r\n+PONG\r\n";
  assert.equal(await receive(expected.length), expected);
  close();
});

test("invalid input gets an error, then the server hangs up", async () => {
  const { client, receive, close } = await connect();

  client.write("hello\r\n");
  const reply = await receive(1);
  await once(client, "end");

  assert.match(reply, /^-ERR Protocol error/);
  close();
});
