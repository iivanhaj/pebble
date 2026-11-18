// Commands that work on any key, whatever type it holds.
import type { Reply } from "../resp/encoder.js";
import * as store from "../store.js";
import { type Command, NOT_AN_INTEGER, invalidExpireTime, parseInteger } from "./shared.js";

export const keyCommands: Record<string, Command> = {
  DEL: { write: true, arity: -2, run: (keys) => keys.filter((key) => store.del(key)).length },
  EXISTS: { arity: -2, run: (keys) => keys.filter((key) => store.has(key)).length },

  // EXPIRE key seconds -> 1 if the timeout was set, 0 if the key doesn't exist
  EXPIRE: {
    write: true,
    arity: 3,
    run: ([key, secondsArg]) => {
      const seconds = parseInteger(secondsArg);
      if (seconds === null) return NOT_AN_INTEGER;
      return expireAt(key, Date.now() + seconds * 1000, "expire");
    },
    toAof: timeoutToAof,
  },

  // PEXPIREAT key unix-time-in-milliseconds -> same replies as EXPIRE.
  // The AOF writes every timeout this way, as an absolute time, so replaying
  // the file later doesn't restart the countdown.
  PEXPIREAT: {
    write: true,
    arity: 3,
    run: ([key, atArg]) => {
      const at = parseInteger(atArg);
      if (at === null) return NOT_AN_INTEGER;
      return expireAt(key, at, "pexpireat");
    },
    toAof: timeoutToAof,
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
  PERSIST: { write: true, arity: 2, run: ([key]) => (store.persist(key) ? 1 : 0) },
};

function expireAt(key: string, at: number, name: string): Reply {
  if (!Number.isSafeInteger(at)) return invalidExpireTime(name);
  if (!store.has(key)) return 0;
  if (at <= Date.now()) store.del(key); // a timeout in the past deletes right away
  else store.setExpiry(key, at);
  return 1;
}

// EXPIRE and PEXPIREAT are recorded as an absolute PEXPIREAT, or as DEL if the
// timeout was already in the past. Nothing is recorded if the key didn't exist.
function timeoutToAof([key]: string[], reply: Reply): string[][] {
  if (reply !== 1) return [];
  const at = store.getExpiry(key);
  return at === undefined ? [["DEL", key]] : [["PEXPIREAT", key, String(at)]];
}
