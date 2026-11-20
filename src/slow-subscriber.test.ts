// A subscriber that stops reading gets disconnected once too much is waiting
// for it. The subscriber here is a real TCP connection that pauses reading;
// messages are published directly through runCommand in the same process.
import { test } from "node:test";
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "./server.js";
import { runCommand } from "./commands/index.js";
import { SUBSCRIBER_HARD_LIMIT, SUBSCRIBER_SOFT_LIMIT, SUBSCRIBER_SOFT_SECONDS } from "./connection.js";

const MB = 1024 * 1024;
const ONE_MB_MESSAGE = "x".repeat(MB);

async function stalledSubscriber(channel: string) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = net.connect((server.address() as AddressInfo).port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(`*2\r\n$9\r\nSUBSCRIBE\r\n$${channel.length}\r\n${channel}\r\n`);
  await once(socket, "data"); // the subscribe confirmation
  socket.pause(); // stop reading: from now on, messages pile up on the server
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  return { server, socket, closed };
}

// Publishes 1 MB messages until the subscriber is dropped (PUBLISH returns 0).
// Returns how many MB it took.
function publishUntilDropped(channel: string, maxMb: number): number {
  for (let mb = 1; mb <= maxMb; mb++) {
    if (runCommand(["PUBLISH", channel, ONE_MB_MESSAGE]) === 0) return mb - 1;
  }
  return -1;
}

test("a subscriber with more than 32 MB waiting is disconnected", { timeout: 20_000 }, async () => {
  const { server, socket, closed } = await stalledSubscriber("hard");
  try {
    const sent = publishUntilDropped("hard", 100);
    assert.ok(sent > 0, "the subscriber was never dropped");
    // Some data sits in the OS's network buffers, so it can take a little
    // more than 32 MB of messages before 32 MB is waiting in Pebble.
    assert.ok(sent * MB > SUBSCRIBER_HARD_LIMIT, `dropped after only ${sent} MB`);
    assert.ok(sent * MB < SUBSCRIBER_HARD_LIMIT + 16 * MB, `took ${sent} MB to drop`);
    socket.resume(); // a paused socket never reads far enough to notice the close
    await closed;
  } finally {
    socket.destroy();
    server.close();
  }
});

test("a subscriber stuck over 8 MB for more than 60 seconds is disconnected", { timeout: 20_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { server, socket, closed } = await stalledSubscriber("soft");
  try {
    const softMb = SUBSCRIBER_SOFT_LIMIT / MB;
    for (let mb = 0; mb < softMb + 8; mb++) runCommand(["PUBLISH", "soft", ONE_MB_MESSAGE]); // over 8 MB, under 32
    assert.equal(runCommand(["PUBLISH", "soft", "still connected?"]), 1);

    t.mock.timers.tick(SUBSCRIBER_SOFT_SECONDS * 1000 - 1000); // 59 seconds: still allowed
    assert.equal(runCommand(["PUBLISH", "soft", "x"]), 1);

    t.mock.timers.tick(2000); // past 60 seconds
    runCommand(["PUBLISH", "soft", "x"]); // this send notices, and drops it
    assert.equal(runCommand(["PUBLISH", "soft", "x"]), 0);
    socket.resume(); // a paused socket never reads far enough to notice the close
    await closed;
  } finally {
    socket.destroy();
    server.close();
  }
});

test("a subscriber that keeps reading is never disconnected", { timeout: 20_000 }, async () => {
  const { server, socket } = await stalledSubscriber("fine");
  try {
    socket.resume(); // reading normally
    let received = 0;
    socket.on("data", (chunk) => (received += chunk.length));
    for (let mb = 0; mb < 50; mb++) {
      assert.equal(runCommand(["PUBLISH", "fine", ONE_MB_MESSAGE]), 1, `dropped at ${mb} MB`);
      await sleep(5); // let the network catch up, as a healthy reader would
    }
    assert.ok(received > 0);
  } finally {
    socket.destroy();
    server.close();
  }
});
