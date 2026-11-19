// Which key to throw out when memory is over --maxmemory.
//
// The store tells the active policy whenever a key is used or removed; when
// memory is full, runCommand asks it for a victim. Policies:
//   noeviction         evict nothing; commands that add data get an OOM error (Redis's default)
//   allkeys-lru-exact  evict the least recently used key, tracked exactly (see lru-list.ts)
import { LruList } from "./lru-list.js";

export type EvictionPolicy = "noeviction" | "allkeys-lru-exact";

interface Tracker {
  touch(key: string): void;
  remove(key: string): void;
  victim(): string | undefined;
  clear(): void;
}

const noTracking: Tracker = {
  touch: () => {},
  remove: () => {},
  victim: () => undefined,
  clear: () => {},
};

class ExactLru implements Tracker {
  private lru = new LruList();
  touch(key: string) { this.lru.touch(key); }
  remove(key: string) { this.lru.remove(key); }
  victim() { return this.lru.oldest(); }
  clear() { this.lru.clear(); }
}

let limit = 0; // bytes; 0 = no limit
let policy: EvictionPolicy = "noeviction";
let tracker: Tracker = noTracking;
let evicted = 0;

// Call before any keys exist (at startup, or after store.clear() in tests):
// the new policy only learns about keys used from now on.
export function configureEviction(options: { maxmemory: number; policy: EvictionPolicy }): void {
  limit = options.maxmemory;
  policy = options.policy;
  tracker = policy === "allkeys-lru-exact" ? new ExactLru() : noTracking;
  evicted = 0;
}

export const maxmemory = () => limit;
export const evictionPolicy = () => policy;
export const evictedKeys = () => evicted;
export const countEviction = () => void evicted++;

export const touch = (key: string) => tracker.touch(key);
export const forget = (key: string) => tracker.remove(key);
export const victim = () => tracker.victim();
export const clearTracking = () => tracker.clear();
