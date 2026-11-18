import type { Reply } from "../resp/encoder.js";
import * as store from "../store.js";
import { type Command, OK, NOT_AN_INTEGER, getString, invalidExpireTime, parseInteger, wrongArgs } from "./shared.js";

export const stringCommands: Record<string, Command> = {
  GET: { arity: 2, run: ([key]) => getString(key) ?? null },

  // SET key value [NX | XX] [EX seconds | PX milliseconds]
  // SET replaces whatever the key held before, of any type.
  SET: {
    write: true,
    arity: -3,
    run: ([key, value, ...options]) => {
      let condition: "NX" | "XX" | undefined;
      let ttlMs: number | undefined;

      for (let i = 0; i < options.length; i++) {
        const option = options[i].toUpperCase();
        if ((option === "NX" || option === "XX") && condition === undefined) {
          condition = option;
        } else if ((option === "EX" || option === "PX") && ttlMs === undefined && i + 1 < options.length) {
          const n = parseInteger(options[++i]);
          if (n === null) return NOT_AN_INTEGER;
          ttlMs = option === "EX" ? n * 1000 : n;
          if (!validTtl(ttlMs)) return invalidExpireTime("set");
        } else {
          return { error: "ERR syntax error" };
        }
      }

      const exists = store.has(key);
      if ((condition === "NX" && exists) || (condition === "XX" && !exists)) return null;
      store.set(key, value);
      if (ttlMs !== undefined) store.setExpiry(key, Date.now() + ttlMs);
      return OK;
    },
    // Recorded as a plain SET, plus PEXPIREAT with the absolute time if it had
    // EX/PX. Nothing is recorded if NX/XX stopped it (reply null).
    toAof: ([key, value], reply) => {
      if (reply === null) return [];
      const at = store.getExpiry(key);
      return at === undefined ? [["SET", key, value]] : [["SET", key, value], ["PEXPIREAT", key, String(at)]];
    },
  },

  INCR: { write: true, arity: 2, run: ([key]) => incrementBy(key, 1n) },
  DECR: { write: true, arity: 2, run: ([key]) => incrementBy(key, -1n) },

  // MGET key [key ...] -> each value, or null for missing keys (and, like Redis,
  // for keys that hold a list, hash or set instead of a string)
  MGET: {
    arity: -2,
    run: (keys) =>
      keys.map((key) => {
        const value = store.get(key);
        return typeof value === "string" ? value : null;
      }),
  },

  // MSET key value [key value ...]
  MSET: {
    write: true,
    arity: -3,
    run: (args) => {
      if (args.length % 2 !== 0) return wrongArgs("mset");
      for (let i = 0; i < args.length; i += 2) store.set(args[i], args[i + 1]);
      return OK;
    },
  },
};

// SET's timeout must be positive and must not overflow when added to the current time.
function validTtl(ms: number): boolean {
  return ms > 0 && Number.isSafeInteger(Date.now() + ms);
}

// Redis stores numbers as strings and does math on 64-bit integers, which is
// bigger than JS numbers can hold exactly, so this uses BigInt.
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function incrementBy(key: string, by: bigint): Reply {
  const current = getString(key) ?? "0"; // a missing key counts as 0
  // Only plain integers: no "+1", " 1", "01" or "1.0", same as Redis.
  if (!/^(0|-?[1-9]\d*)$/.test(current)) return NOT_AN_INTEGER;
  const n = BigInt(current);
  if (n < INT64_MIN || n > INT64_MAX) return NOT_AN_INTEGER;
  const next = n + by;
  if (next < INT64_MIN || next > INT64_MAX) return { error: "ERR increment or decrement would overflow" };
  store.set(key, next.toString(), { keepTtl: true });
  return next;
}
