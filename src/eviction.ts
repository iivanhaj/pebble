// Which key to throw out when memory is over --maxmemory.
//
// The store tells the active policy whenever a key is used or removed; when
// memory is full, runCommand asks it for a victim. Policies (Redis's names):
//   noeviction         evict nothing; commands that add data get an OOM error (Redis's default)
//   allkeys-lru        sampled LRU, like real Redis: of N random keys, evict the one used longest ago
//   allkeys-lru-exact  exact LRU: always the least recently used key (see lru-list.ts)
//   allkeys-random     any random key
import { LruList } from "./lru-list.js";
import { RandomKeySet } from "./random-key-set.js";

export type EvictionPolicy = "noeviction" | "allkeys-lru" | "allkeys-lru-exact" | "allkeys-random";
export const POLICIES: EvictionPolicy[] = ["noeviction", "allkeys-lru", "allkeys-lru-exact", "allkeys-random"];

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

// Redis's approach. No ordered list: each key just remembers when it was last
// used (a counter that goes up on every use). To pick a victim, look at a few
// random keys and take the one used longest ago. Usually an old key, rarely
// the very oldest, for much less bookkeeping than an exact list.
//
// Keys live in an array (plus key -> position) so a random one can be picked
// in O(1), like RandomKeySet, with each key's last-used time in a second array
// at the same position.
class SampledLru implements Tracker {
  private keys: string[] = [];
  private lastUsed: number[] = [];
  private positions = new Map<string, number>();
  private clock = 0;

  constructor(private samples: number) {}

  touch(key: string) {
    const position = this.positions.get(key);
    if (position === undefined) {
      this.positions.set(key, this.keys.length);
      this.keys.push(key);
      this.lastUsed.push(++this.clock);
    } else {
      this.lastUsed[position] = ++this.clock;
    }
  }

  remove(key: string) {
    const position = this.positions.get(key);
    if (position === undefined) return;
    const lastKey = this.keys.pop()!;
    const lastTime = this.lastUsed.pop()!;
    if (lastKey !== key) {
      this.keys[position] = lastKey; // move the last key into the freed slot
      this.lastUsed[position] = lastTime;
      this.positions.set(lastKey, position);
    }
    this.positions.delete(key);
  }

  victim() {
    if (this.keys.length === 0) return undefined;
    let best = -1;
    for (let i = 0; i < this.samples; i++) {
      const position = Math.floor(Math.random() * this.keys.length);
      if (best === -1 || this.lastUsed[position] < this.lastUsed[best]) best = position;
    }
    return this.keys[best];
  }

  clear() {
    this.keys.length = 0;
    this.lastUsed.length = 0;
    this.positions.clear();
  }
}

class RandomEviction implements Tracker {
  private keys = new RandomKeySet();
  touch(key: string) { this.keys.add(key); }
  remove(key: string) { this.keys.delete(key); }
  victim() { return this.keys.random(); }
  clear() { this.keys.clear(); }
}

let limit = 0; // bytes; 0 = no limit
let policy: EvictionPolicy = "noeviction";
let tracker: Tracker = noTracking;
let evicted = 0;

// Call before any keys exist (at startup, or after store.clear() in tests):
// the new policy only learns about keys used from now on.
export function configureEviction(options: { maxmemory: number; policy: EvictionPolicy; samples?: number }): void {
  limit = options.maxmemory;
  policy = options.policy;
  tracker =
    policy === "allkeys-lru" ? new SampledLru(options.samples ?? 5)
    : policy === "allkeys-lru-exact" ? new ExactLru()
    : policy === "allkeys-random" ? new RandomEviction()
    : noTracking;
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
