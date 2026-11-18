// Commands that work on any key, whatever type it holds.
import * as store from "../store.js";
import { type Command, NOT_AN_INTEGER, invalidExpireTime, parseInteger } from "./shared.js";

export const keyCommands: Record<string, Command> = {
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
};
