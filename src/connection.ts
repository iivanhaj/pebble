import type { Socket } from "node:net";
import { parse, ProtocolError } from "./resp/parser.js";
import { encode } from "./resp/encoder.js";
import { runCommand } from "./commands/index.js";
import { createClient } from "./client.js";
import * as pubsub from "./pubsub.js";
import * as watch from "./watch.js";

// A subscriber that stops reading makes published messages pile up in this
// process's memory, waiting to be sent. Like Redis's defaults
// ("client-output-buffer-limit pubsub 32mb 8mb 60"), disconnect a subscriber
// with more than 32 MB waiting, or more than 8 MB waiting for over 60 seconds.
// Ordinary clients have no limit, as in Redis.
export const SUBSCRIBER_HARD_LIMIT = 32 * 1024 * 1024;
export const SUBSCRIBER_SOFT_LIMIT = 8 * 1024 * 1024;
export const SUBSCRIBER_SOFT_SECONDS = 60;

// One per client. Keeps the bytes that haven't made a whole command yet, and
// runs every whole command as soon as it has arrived.
export function handleConnection(socket: Socket): void {
  let leftovers = Buffer.alloc(0);
  let overSoftLimitSince: number | null = null;

  const client = createClient((reply) => {
    socket.write(encode(reply));
    if (client.subscriptions.size > 0) checkSubscriberBacklog();
  });

  // socket.writableLength: bytes written but not yet taken by the network.
  function checkSubscriberBacklog(): void {
    const waiting = socket.writableLength;
    if (waiting <= SUBSCRIBER_SOFT_LIMIT) {
      overSoftLimitSince = null;
      return;
    }
    overSoftLimitSince ??= Date.now();
    const tooLong = Date.now() - overSoftLimitSince > SUBSCRIBER_SOFT_SECONDS * 1000;
    if (waiting > SUBSCRIBER_HARD_LIMIT || tooLong) {
      pubsub.unsubscribeAll(client); // stop sending to it right away
      socket.destroy(); // and drop what's waiting
    }
  }

  socket.on("data", (chunk) => {
    if (client.closeAfterReply) return; // after QUIT, ignore anything else sent
    leftovers = Buffer.concat([leftovers, chunk]);
    try {
      let result;
      while ((result = parse(leftovers)) !== null) {
        leftovers = leftovers.subarray(result.used);
        if (result.words.length === 0) continue; // "*0\r\n": nothing to run
        client.send(runCommand(result.words, client));
        if (client.closeAfterReply) {
          socket.end(); // QUIT: close once the reply has been sent
          return;
        }
      }
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      // Like Redis: report the bad input, then hang up.
      socket.end(encode({ error: `ERR ${err.message}` }));
    }
  });

  socket.on("error", () => {
    // Client went away mid-write (e.g. connection reset); "close" follows and cleans up.
  });

  socket.on("close", () => {
    pubsub.unsubscribeAll(client); // otherwise PUBLISH would keep writing to a dead socket
    watch.unwatchAll(client);
  });
}
