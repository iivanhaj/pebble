// The notebook: every key and its value, plus expiry times for keys that have one.
//
// Expired keys are removed two ways, like Redis:
//   - lazily: every read checks the key's expiry first (expireIfNeeded)
//   - actively: activeExpireCycle() samples random keys with a timeout, so keys
//     nobody reads again still get cleaned up

const values = new Map<string, string>();

// Only keys with a timeout are in here. `slot` is the key's index in ttlKeys.
const expires = new Map<string, { at: number; slot: number }>();

// The same keys as `expires`, in an array so we can pick a random one in O(1).
// Removing one swaps the last key into its slot, so removal is O(1) too.
const ttlKeys: string[] = [];

// ---- Reads and writes (all go through expireIfNeeded) ----

export function get(key: string): string | undefined {
  expireIfNeeded(key);
  return values.get(key);
}

export function has(key: string): boolean {
  expireIfNeeded(key);
  return values.has(key);
}

// Like Redis, a plain SET throws away any old timeout.
export function set(key: string, value: string): void {
  values.set(key, value);
  forgetExpiry(key);
}

export function del(key: string): boolean {
  expireIfNeeded(key);
  return remove(key);
}

// ---- Timeouts ----

// `at` is a Date.now()-style timestamp in milliseconds. The key must exist.
export function setExpiry(key: string, at: number): void {
  const entry = expires.get(key);
  if (entry) {
    entry.at = at;
  } else {
    expires.set(key, { at, slot: ttlKeys.length });
    ttlKeys.push(key);
  }
}

export function getExpiry(key: string): number | undefined {
  expireIfNeeded(key);
  return expires.get(key)?.at;
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

  while (ttlKeys.length > 0) {
    const sampled = Math.min(SAMPLE_SIZE, ttlKeys.length);
    let expired = 0;
    for (let i = 0; i < sampled; i++) {
      const key = ttlKeys[Math.floor(Math.random() * ttlKeys.length)];
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

// ---- For tests ----

// Counts keys without checking expiry, like Redis's DBSIZE: expired keys that
// haven't been cleaned up yet still count.
export function size(): number {
  return values.size;
}

export function clear(): void {
  values.clear();
  expires.clear();
  ttlKeys.length = 0;
}

// ---- Internals ----

function isExpired(key: string): boolean {
  const entry = expires.get(key);
  return entry !== undefined && Date.now() > entry.at;
}

function expireIfNeeded(key: string): void {
  if (isExpired(key)) remove(key);
}

function remove(key: string): boolean {
  forgetExpiry(key);
  return values.delete(key);
}

function forgetExpiry(key: string): boolean {
  const entry = expires.get(key);
  if (!entry) return false;
  const last = ttlKeys.pop()!;
  if (last !== key) {
    ttlKeys[entry.slot] = last; // move the last key into the freed slot
    expires.get(last)!.slot = entry.slot;
  }
  expires.delete(key);
  return true;
}
