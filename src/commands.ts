import type { Reply } from "./resp/encoder.js";
import * as store from "./store.js";

// arity follows Redis's convention: it counts the command name itself, and a
// negative number means "at least". GET is 2 (GET key); DEL is -2 (DEL key [key ...]).
type Command = { arity: number; run: (args: string[]) => Reply };

const OK: Reply = { simple: "OK" };

const commands: Record<string, Command> = {
  PING: {
    arity: -1,
    run: (args) => {
      if (args.length > 1) return wrongArgs("ping");
      return args.length === 0 ? { simple: "PONG" } : args[0];
    },
  },
  ECHO: { arity: 2, run: ([message]) => message },
  GET: { arity: 2, run: ([key]) => store.get(key) ?? null },

  // SET key value [NX | XX] [EX seconds | PX milliseconds]
  SET: {
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
  },

  DEL: { arity: -2, run: (keys) => keys.filter((key) => store.del(key)).length },
  EXISTS: { arity: -2, run: (keys) => keys.filter((key) => store.has(key)).length },

  // EXPIRE key seconds -> 1 if the timeout was set, 0 if the key doesn't exist
  EXPIRE: {
    arity: 3,
    run: ([key, secondsArg]) => {
      const seconds = parseInteger(secondsArg);
      if (seconds === null) return NOT_AN_INTEGER;
      const at = Date.now() + seconds * 1000;
      if (!Number.isSafeInteger(at)) return invalidExpireTime("expire");
      if (!store.has(key)) return 0;
      if (seconds <= 0) store.del(key); // a timeout in the past deletes right away
      else store.setExpiry(key, at);
      return 1;
    },
  },

  // TTL key -> seconds left, -1 if the key has no timeout, -2 if it doesn't exist
  TTL: {
    arity: 2,
    run: ([key]) => {
      if (!store.has(key)) return -2;
      const at = store.getExpiry(key);
      if (at === undefined) return -1;
      return Math.round((at - Date.now()) / 1000);
    },
  },

  // PERSIST key -> 1 if a timeout was removed, 0 otherwise
  PERSIST: { arity: 2, run: ([key]) => (store.persist(key) ? 1 : 0) },

  INCR: { arity: 2, run: ([key]) => incrementBy(key, 1n) },
  DECR: { arity: 2, run: ([key]) => incrementBy(key, -1n) },

  // MGET key [key ...] -> each value, or null for missing keys
  MGET: { arity: -2, run: (keys) => keys.map((key) => store.get(key) ?? null) },

  // MSET key value [key value ...]
  MSET: {
    arity: -3,
    run: (args) => {
      if (args.length % 2 !== 0) return wrongArgs("mset");
      for (let i = 0; i < args.length; i += 2) store.set(args[i], args[i + 1]);
      return OK;
    },
  },

  // INFO [section ...] -> "# Section\r\nfield:value\r\n..." as one bulk string.
  // Clients like ioredis send INFO on connect and wait until "loading:0".
  INFO: {
    arity: -1,
    run: (args) => {
      const wanted = args.map((arg) => arg.toLowerCase());
      const showAll = wanted.length === 0 || wanted.some((w) => ["all", "everything", "default"].includes(w));
      return infoSections()
        .filter(([name]) => showAll || wanted.includes(name.toLowerCase()))
        .map(([name, fields]) => `# ${name}\r\n${fields.map((field) => `${field}\r\n`).join("")}`)
        .join("\r\n");
    },
  },
};

function infoSections(): [string, string[]][] {
  const keys = store.size();
  return [
    ["Server", ["pebble_version:0.1.0", `process_id:${process.pid}`, `uptime_in_seconds:${Math.floor(process.uptime())}`]],
    ["Persistence", ["loading:0"]], // nothing is loaded from disk yet
    ["Keyspace", keys > 0 ? [`db0:keys=${keys},expires=${store.expiringCount()},avg_ttl=0`] : []],
  ];
}

// Redis stores numbers as strings and does math on 64-bit integers, which is
// bigger than JS numbers can hold exactly, so this uses BigInt.
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function incrementBy(key: string, by: bigint): Reply {
  const current = store.get(key) ?? "0"; // a missing key counts as 0
  // Only plain integers: no "+1", " 1", "01" or "1.0", same as Redis.
  if (!/^(0|-?[1-9]\d*)$/.test(current)) return NOT_AN_INTEGER;
  const n = BigInt(current);
  if (n < INT64_MIN || n > INT64_MAX) return NOT_AN_INTEGER;
  const next = n + by;
  if (next < INT64_MIN || next > INT64_MAX) return { error: "ERR increment or decrement would overflow" };
  store.set(key, next.toString(), { keepTtl: true });
  return next;
}

export function runCommand(words: string[]): Reply {
  const [name, ...args] = words;
  const upper = name.toUpperCase();
  if (!Object.hasOwn(commands, upper)) {
    const preview = args.map((arg) => `'${arg}'`).join(" ");
    return { error: `ERR unknown command '${name}', with args beginning with: ${preview}` };
  }
  const command = commands[upper];
  const ok = command.arity > 0 ? words.length === command.arity : words.length >= -command.arity;
  if (!ok) return wrongArgs(name.toLowerCase());
  return command.run(args);
}

const NOT_AN_INTEGER: Reply = { error: "ERR value is not an integer or out of range" };

// "42" -> 42, "-7" -> -7; anything else ("4.2", "abc", "", huge numbers) -> null
function parseInteger(text: string): number | null {
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// SET's timeout must be positive and must not overflow when added to the current time.
function validTtl(ms: number): boolean {
  return ms > 0 && Number.isSafeInteger(Date.now() + ms);
}

function invalidExpireTime(name: string): Reply {
  return { error: `ERR invalid expire time in '${name}' command` };
}

function wrongArgs(name: string): Reply {
  return { error: `ERR wrong number of arguments for '${name}' command` };
}
