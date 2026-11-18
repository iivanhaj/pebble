// A set is a collection of unique strings, with no order.
import { type Command, deleteIfEmpty, getOrCreateSet, getSet } from "./shared.js";

export const setCommands: Record<string, Command> = {
  // SADD key member [member ...] -> how many were new
  SADD: {
    write: true,
    arity: -3,
    run: ([key, ...members]) => {
      const set = getOrCreateSet(key);
      const before = set.size;
      for (const member of members) set.add(member);
      return set.size - before;
    },
  },

  // SREM key member [member ...] -> how many were removed
  SREM: {
    write: true,
    arity: -3,
    run: ([key, ...members]) => {
      const set = getSet(key);
      if (!set) return 0;
      const removed = members.filter((member) => set.delete(member)).length;
      deleteIfEmpty(key, set.size);
      return removed;
    },
  },

  SMEMBERS: { arity: 2, run: ([key]) => [...(getSet(key) ?? [])] },

  // SISMEMBER key member -> 1 or 0
  SISMEMBER: { arity: 3, run: ([key, member]) => (getSet(key)?.has(member) ? 1 : 0) },
};
