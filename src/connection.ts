import type { Socket } from "node:net";
import { parse, ProtocolError } from "./resp/parser.js";
import { encode } from "./resp/encoder.js";
import { runCommand } from "./commands/index.js";
import type { Client } from "./client.js";

// One per client. Keeps the bytes that haven't made a whole command yet, and
// runs every whole command as soon as it has arrived.
export function handleConnection(socket: Socket): void {
  let leftovers = Buffer.alloc(0);
  const client: Client = {
    send: (reply) => socket.write(encode(reply)),
    closeAfterReply: false,
  };

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
    // Client went away mid-write (e.g. connection reset); nothing to clean up yet.
  });
}
