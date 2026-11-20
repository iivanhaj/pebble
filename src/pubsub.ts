// Pub/sub: who is listening to which channel.
//
// Each channel maps to the set of clients subscribed to it, and each client
// also keeps its own set of channels (client.subscriptions), so a client that
// disconnects can be removed from everything in one go. Nothing is stored:
// PUBLISH sends to whoever is listening right now, and if nobody is, the
// message is simply dropped.
import type { Client } from "./client.js";

const channels = new Map<string, Set<Client>>();

export function subscribe(client: Client, channel: string): void {
  let listeners = channels.get(channel);
  if (!listeners) channels.set(channel, (listeners = new Set()));
  listeners.add(client);
  client.subscriptions.add(channel);
}

export function unsubscribe(client: Client, channel: string): void {
  client.subscriptions.delete(channel);
  const listeners = channels.get(channel);
  if (!listeners) return;
  listeners.delete(client);
  if (listeners.size === 0) channels.delete(channel); // don't keep empty channels around
}

export function unsubscribeAll(client: Client): void {
  for (const channel of [...client.subscriptions]) unsubscribe(client, channel);
}

// Sends the message to every client listening on the channel. Returns how many.
export function publish(channel: string, message: string): number {
  const listeners = channels.get(channel);
  if (!listeners) return 0;
  // Copy first: sending can disconnect a client that can't keep up, which
  // removes it from this set while we're going through it.
  const receivers = [...listeners];
  for (const client of receivers) client.send(["message", channel, message]);
  return receivers.length;
}

// Channels with at least one listener (for INFO).
export function channelCount(): number {
  return channels.size;
}

export function clear(): void {
  channels.clear();
}
