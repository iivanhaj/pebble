import type { Reply } from "./resp/encoder.js";

// The connection a command came from. Most commands ignore it; the ones that
// need to know who's asking (SUBSCRIBE), send to a client outside its own
// reply (PUBLISH), or change the connection (QUIT) use it.
export interface Client {
  // Sends a reply to this client right away.
  send(reply: Reply): void;
  // Set by QUIT: the connection closes once the reply is sent.
  closeAfterReply: boolean;
  // Channels this client is subscribed to (see pubsub.ts).
  subscriptions: Set<string>;
  // Between MULTI and EXEC: the queued commands, and whether one of them was
  // rejected while queuing (then EXEC refuses to run any of them).
  transaction: { queue: string[][]; failed: boolean } | null;
}

export function createClient(send: (reply: Reply) => void): Client {
  return { send, closeAfterReply: false, subscriptions: new Set(), transaction: null };
}

// For commands that don't come from a connection: AOF replay, benchmarks, tests.
export function detachedClient(): Client {
  return createClient(() => {});
}
