// WATCH: optimistic locking without locks.
//
// A client WATCHes some keys, reads them, decides what to write, then sends
// MULTI ... EXEC. If any watched key changed in the meantime, EXEC refuses
// (replies nil) and the client simply tries again. Nobody ever waits for a lock.
//
// Like Redis: each key maps to the clients watching it. When a key changes,
// every client watching it is flagged (client.watchedKeyChanged), and EXEC
// checks the flag. Changes are reported from two places, so none are missed:
//   - runCommand, for every key a successful write command touched (this also
//     catches lists, hashes and sets changed in place)
//   - the store, whenever it removes a key (DEL, expiry, eviction)
// That's deliberately cautious: a write command that touched a key without
// changing it (say, a SET NX that didn't set) still counts. The cost is an
// unneeded retry, never a missed change.
import type { Client } from "./client.js";

const watchers = new Map<string, Set<Client>>();

export function watch(client: Client, key: string): void {
  let clients = watchers.get(key);
  if (!clients) watchers.set(key, (clients = new Set()));
  clients.add(client);
  client.watching.add(key);
}

// Drops all of the client's watches and clears its flag. Happens after every
// EXEC (whether it ran or not), DISCARD, UNWATCH, and when the client disconnects.
export function unwatchAll(client: Client): void {
  for (const key of client.watching) {
    const clients = watchers.get(key);
    clients?.delete(client);
    if (clients?.size === 0) watchers.delete(key);
  }
  client.watching.clear();
  client.watchedKeyChanged = false;
}

export function keyModified(key: string): void {
  const clients = watchers.get(key);
  if (!clients) return;
  for (const client of clients) client.watchedKeyChanged = true;
}

export function clear(): void {
  watchers.clear();
}
