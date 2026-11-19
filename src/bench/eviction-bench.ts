// Compares eviction policies: cache hit rate on a realistic workload, speed,
// and how much memory each policy's bookkeeping costs per key.
//
//   npm run bench:eviction
//
// Workload: Pebble as a cache in front of 100,000 possible keys, with room for
// 10% of them. 1,000,000 requests, where key popularity follows a Zipf
// distribution (a few keys are very popular, most are rare), as real traffic
// tends to. Each request is a GET; on a miss, the key is SET (which may evict).
import { runCommand as run } from "../commands/index.js";
import { configureEviction, type EvictionPolicy } from "../eviction.js";
import { sizeOf } from "../values.js";
import * as store from "../store.js";

const UNIVERSE = 100_000;
const CACHE_FRACTION = 0.1;
const REQUESTS = 1_000_000;
const ZIPF_EXPONENT = 1;
const VALUE = "v".repeat(50);

// A small seeded random number generator (mulberry32), so every policy sees
// exactly the same sequence of requests.
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Key i is requested with probability proportional to 1 / (i+1)^s. Picks one
// by binary search over the running total of those weights.
function zipfRequests(count: number): number[] {
  const cumulative = new Float64Array(UNIVERSE);
  let total = 0;
  for (let i = 0; i < UNIVERSE; i++) cumulative[i] = total += 1 / (i + 1) ** ZIPF_EXPONENT;
  const random = seededRandom(42);
  const requests: number[] = new Array(count);
  for (let r = 0; r < count; r++) {
    const target = random() * total;
    let lo = 0;
    let hi = UNIVERSE - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    requests[r] = lo;
  }
  return requests;
}

const key = (i: number) => `key:${String(i).padStart(6, "0")}`; // all keys the same length

function hitRate(policy: EvictionPolicy, samples: number | undefined, requests: number[]) {
  store.clear();
  const maxmemory = Math.floor(UNIVERSE * CACHE_FRACTION) * sizeOf(key(0), VALUE);
  configureEviction({ maxmemory, policy, samples });
  let hits = 0;
  const start = performance.now();
  for (const i of requests) {
    if (run(["GET", key(i)]) !== null) hits++;
    else run(["SET", key(i), VALUE]);
  }
  const seconds = (performance.now() - start) / 1000;
  return { hitRate: hits / requests.length, opsPerSecond: Math.round(requests.length / seconds) };
}

function heapUsed(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return NaN;
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

// Extra heap per key for the policy's bookkeeping, compared to noeviction.
function bookkeepingBytesPerKey(policy: EvictionPolicy): number {
  const keys = 1_000_000;
  store.clear();
  configureEviction({ maxmemory: 0, policy }); // no limit: only the tracking is measured
  const before = heapUsed();
  for (let i = 0; i < keys; i++) run(["SET", `k${i}`, "v"]);
  const after = heapUsed();
  store.clear();
  return (after - before) / keys;
}

const policies: [string, EvictionPolicy, number | undefined][] = [
  ["allkeys-lru-exact", "allkeys-lru-exact", undefined],
  ["allkeys-lru, 10 samples", "allkeys-lru", 10],
  ["allkeys-lru, 5 samples (Redis default)", "allkeys-lru", 5],
  ["allkeys-lru, 3 samples", "allkeys-lru", 3],
  ["allkeys-random", "allkeys-random", undefined],
];

console.log(`Hit rate: ${REQUESTS.toLocaleString("en-US")} Zipf(${ZIPF_EXPONENT}) requests over ${UNIVERSE.toLocaleString("en-US")} keys, cache holds ${CACHE_FRACTION * 100}%\n`);
const requests = zipfRequests(REQUESTS);
console.log("policy".padEnd(40) + "hit rate".padStart(10) + "ops/sec".padStart(12));
for (const [name, policy, samples] of policies) {
  const result = hitRate(policy, samples, requests);
  console.log(name.padEnd(40) + `${(result.hitRate * 100).toFixed(2)}%`.padStart(10) + result.opsPerSecond.toLocaleString("en-US").padStart(12));
}

if (Number.isNaN(heapUsed())) {
  console.log("\n(Run with node --expose-gc to measure bookkeeping memory.)");
} else {
  console.log("\nBookkeeping memory per key (1,000,000 keys, compared to noeviction)\n");
  const baseline = bookkeepingBytesPerKey("noeviction");
  for (const policy of ["allkeys-lru-exact", "allkeys-lru", "allkeys-random"] as EvictionPolicy[]) {
    const extra = bookkeepingBytesPerKey(policy) - baseline;
    console.log(policy.padEnd(40) + `${extra.toFixed(0)} bytes`.padStart(10));
  }
}
