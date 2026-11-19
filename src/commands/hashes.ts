// A hash is a small map inside one key: field -> value. E.g. user:1 -> {name, email}.
import { type Command, deleteIfEmpty, getHash, getOrCreateHash, wrongArgs } from "./shared.js";

export const hashCommands: Record<string, Command> = {
  // HSET key field value [field value ...] -> how many fields were new
  HSET: {
    write: true,
    denyoom: true,
    arity: -4,
    run: ([key, ...pairs]) => {
      if (pairs.length % 2 !== 0) return wrongArgs("hset");
      const hash = getOrCreateHash(key);
      let added = 0;
      for (let i = 0; i < pairs.length; i += 2) {
        if (!hash.has(pairs[i])) added++;
        hash.set(pairs[i], pairs[i + 1]);
      }
      return added;
    },
  },

  // HGET key field -> the value, or null
  HGET: { arity: 3, run: ([key, field]) => getHash(key)?.get(field) ?? null },

  // HGETALL key -> [field1, value1, field2, value2, ...]
  HGETALL: { arity: 2, run: ([key]) => [...(getHash(key) ?? [])].flat() },

  // HDEL key field [field ...] -> how many fields were removed
  HDEL: {
    write: true,
    arity: -3,
    run: ([key, ...fields]) => {
      const hash = getHash(key);
      if (!hash) return 0;
      const removed = fields.filter((field) => hash.delete(field)).length;
      deleteIfEmpty(key, hash.size);
      return removed;
    },
  },
};
