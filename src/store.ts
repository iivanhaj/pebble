import { RandomKeySet } from "./random-key-set.js";
import { type Value, sizeOf } from "./values.js";
import * as eviction from "./eviction.js";

export type { Value };

// The notebook: every key and its value, plus expiry times for keys that have one.
//
// Expired keys are removed two ways, like Redis:
//   - lazily: every read checks the key's expiry first (expireIfNeeded)
//   - actively: activeExpireCycle() samples random keys with a timeout, so keys
//     nobody reads again still get cleaned up

const values = new Map<string, Value>();

// Estimated memory: each key's size, and the total. Commands change lists,
// hashes and sets in place, so the store can't see every change as it happens.
// Instead, every key a command touches is noted, and settle() (run after each
// command) re-measures just those keys. Measuring is O(1); see values.ts.
const sizes = new Map<string, number>();
let usedBytes = 0;
const touched = new Set<string>();

// Only keys with a timeout are in here: key -> unix time in ms.
const expires = new Map<string, number>();

// The same keys again, so active expiry can pick random ones in O(1).
const ttlKeys = new RandomKeySet();

// ---- Reads and writes (all go through expireIfNeeded) ----

export function get(key: string): Value | undefined {
  expireIfNeeded(key);
  touched.add(key);
  return values.get(key);
}

export function has(key: string): boolean {
  expireIfNeeded(key);
  touched.add(key);
  return values.has(key);
}

// Like Redis, a plain SET throws away any old timeout. Commands that change a
// value in place (INCR, DECR) pass keepTtl so the timeout survives.
export function set(key: string, value: Value, { keepTtl = false } = {}): void {
  values.set(key, value);
  touched.add(key);
  if (!keepTtl) forgetExpiry(key);
}

export function del(key: string): boolean {
  expireIfNeeded(key);
  return remove(key);
}

// ---- Timeouts ----

// `at` is a Date.now()-style timestamp in milliseconds. The key must exist.
export function setExpiry(key: string, at: number): void {
  expires.set(key, at);
  ttlKeys.add(key);
}

export function getExpiry(key: string): number | undefined {
  expireIfNeeded(key);
  return expires.get(key);
}

// Removes the key's timeout. Returns false if it had none (or doesn't exist).
export function persist(key: string): boolean {
  expireIfNeeded(key);
  return forgetExpiry(key);
}

// ---- Active expiry (Redis's algorithm, simplified) ----

const SAMPLE_SIZE = 20;
const TIME_BUDGET_MS = 25;

// Run about 10 times a second. Samples 20 random keys with a timeout and deletes
// the expired ones. If more than a quarter of the sample was expired, there are
// probably many more, so it samples again, until it runs out of time budget.
// Returns how many keys it deleted.
export function activeExpireCycle(): number {
  const start = Date.now();
  let deleted = 0;

  while (ttlKeys.size > 0) {
    const sampled = Math.min(SAMPLE_SIZE, ttlKeys.size);
    let expired = 0;
    for (let i = 0; i < sampled; i++) {
      const key = ttlKeys.random()!;
      if (isExpired(key)) {
        remove(key);
        expired++;
      }
    }
    deleted += expired;
    if (expired <= sampled / 4 || Date.now() - start > TIME_BUDGET_MS) break;
  }
  return deleted;
}

// ---- For snapshots ----

// Every key with its value and expiry time (undefined if none). Doesn't check
// expiry: a snapshot saves exactly what's in memory.
export function* entries(): Generator<[string, Value, number | undefined]> {
  for (const [key, value] of values) yield [key, value, expires.get(key)];
}

// ---- Memory ----

// Re-measures every key touched since the last call, and tells the eviction
// policy those keys were just used. Called after each command.
export function settle(): void {
  for (const key of touched) {
    const value = values.get(key);
    const old = sizes.get(key) ?? 0;
    const now = value === undefined ? 0 : sizeOf(key, value);
    usedBytes += now - old;
    if (value === undefined) {
      sizes.delete(key);
      eviction.forget(key);
    } else {
      sizes.set(key, now);
      eviction.touch(key);
    }
  }
  touched.clear();
}

// Estimated bytes used by all keys (as of the last settle()).
export function usedMemory(): number {
  return usedBytes;
}

// The same total, worked out from scratch. Slow; only for tests to check usedMemory().
export function measureFromScratch(): number {
  let total = 0;
  for (const [key, value] of values) total += sizeOf(key, value);
  return total;
}

// ---- Counts (for INFO and tests) ----

// Counts keys without checking expiry, like Redis's DBSIZE: expired keys that
// haven't been cleaned up yet still count.
export function size(): number {
  return values.size;
}

// How many keys have a timeout.
export function expiringCount(): number {
  return ttlKeys.size;
}

// ---- For tests ----

export function clear(): void {
  values.clear();
  expires.clear();
  ttlKeys.clear();
  sizes.clear();
  usedBytes = 0;
  touched.clear();
  eviction.clearTracking();
}

// ---- Internals ----

// While the AOF is being replayed, nothing expires: a key's later commands in
// the file happened before its deadline, so it must still exist when they run.
let loading = false;

export function setLoading(on: boolean): void {
  loading = on;
}

export function isLoading(): boolean {
  return loading;
}

function isExpired(key: string): boolean {
  if (loading) return false;
  const at = expires.get(key);
  return at !== undefined && Date.now() > at;
}

function expireIfNeeded(key: string): void {
  if (isExpired(key)) remove(key);
}

function remove(key: string): boolean {
  forgetExpiry(key);
  usedBytes -= sizes.get(key) ?? 0;
  sizes.delete(key);
  eviction.forget(key);
  return values.delete(key);
}

function forgetExpiry(key: string): boolean {
  ttlKeys.delete(key);
  return expires.delete(key);
}
