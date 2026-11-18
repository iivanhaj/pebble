import type { Reply } from "../resp/encoder.js";
import * as store from "../store.js";
import { Deque } from "../deque.js";

// arity follows Redis's convention: it counts the command name itself, and a
// negative number means "at least". GET is 2 (GET key); DEL is -2 (DEL key [key ...]).
export type Command = { arity: number; run: (args: string[]) => Reply };

export const OK: Reply = { simple: "OK" };
export const NOT_AN_INTEGER: Reply = { error: "ERR value is not an integer or out of range" };

export function wrongArgs(name: string): Reply {
  return { error: `ERR wrong number of arguments for '${name}' command` };
}

export function invalidExpireTime(name: string): Reply {
  return { error: `ERR invalid expire time in '${name}' command` };
}

// "42" -> 42, "-7" -> -7; anything else ("4.2", "abc", "", huge numbers) -> null
export function parseInteger(text: string): number | null {
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// ---- Reading a key as a specific type ----
//
// Each getter returns undefined if the key doesn't exist, and throws
// WrongTypeError if it holds a different type. runCommand turns that into
// Redis's WRONGTYPE error, so a command can't forget to check.

export class WrongTypeError extends Error {}

function getTyped<T extends store.Value>(key: string, isType: (value: store.Value) => value is T): T | undefined {
  const value = store.get(key);
  if (value === undefined) return undefined;
  if (!isType(value)) throw new WrongTypeError();
  return value;
}

export const getString = (key: string) => getTyped(key, (v): v is string => typeof v === "string");
export const getList = (key: string) => getTyped(key, (v): v is Deque<string> => v instanceof Deque);
export const getHash = (key: string) => getTyped(key, (v): v is Map<string, string> => v instanceof Map);
export const getSet = (key: string) => getTyped(key, (v): v is Set<string> => v instanceof Set);

// For writes: same as above, but a missing key is created empty.
export const getOrCreateList = (key: string) => getList(key) ?? created(key, new Deque<string>());
export const getOrCreateHash = (key: string) => getHash(key) ?? created(key, new Map<string, string>());
export const getOrCreateSet = (key: string) => getSet(key) ?? created(key, new Set<string>());

function created<T extends store.Value>(key: string, value: T): T {
  store.set(key, value);
  return value;
}

// Redis never keeps an empty list, hash or set: removing the last item deletes the key.
export function deleteIfEmpty(key: string, size: number): void {
  if (size === 0) store.del(key);
}
