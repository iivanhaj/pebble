import type { Reply } from "../resp/encoder.js";
import { type Command, NOT_AN_INTEGER, deleteIfEmpty, getList, getOrCreateList, parseInteger } from "./shared.js";

export const listCommands: Record<string, Command> = {
  // LPUSH key element [element ...] -> new length. Each element goes to the
  // front in turn, so LPUSH k a b c gives the list c b a.
  LPUSH: {
    write: true,
    denyoom: true,
    arity: -3,
    run: ([key, ...elements]) => {
      const list = getOrCreateList(key);
      for (const element of elements) list.pushFront(element);
      return list.length;
    },
  },

  // RPUSH key element [element ...] -> new length
  RPUSH: {
    write: true,
    denyoom: true,
    arity: -3,
    run: ([key, ...elements]) => {
      const list = getOrCreateList(key);
      for (const element of elements) list.pushBack(element);
      return list.length;
    },
  },

  LPOP: { write: true, arity: 2, run: ([key]) => pop(key, "front") },
  RPOP: { write: true, arity: 2, run: ([key]) => pop(key, "back") },

  // LRANGE key start stop -> elements from start to stop, both included.
  // Negative indexes count from the end: -1 is the last element.
  LRANGE: {
    arity: 4,
    run: ([key, startArg, stopArg]) => {
      let start = parseInteger(startArg);
      let stop = parseInteger(stopArg);
      if (start === null || stop === null) return NOT_AN_INTEGER;
      const list = getList(key);
      if (!list) return [];

      const length = list.length;
      if (start < 0) start = Math.max(length + start, 0);
      if (stop < 0) stop = length + stop;
      stop = Math.min(stop, length - 1);

      const result: string[] = [];
      for (let i = start; i <= stop; i++) result.push(list.at(i)!);
      return result;
    },
  },
};

// LPOP/RPOP key -> the removed element, or null if the list doesn't exist
function pop(key: string, end: "front" | "back"): Reply {
  const list = getList(key);
  if (!list) return null;
  const element = end === "front" ? list.popFront()! : list.popBack()!;
  deleteIfEmpty(key, list.length);
  return element;
}
