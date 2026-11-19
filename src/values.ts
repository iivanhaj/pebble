// The list, hash and set types a key can hold. Each one keeps a running count
// of the characters it holds (`bytes`), updated as items go in and out, so the
// store can estimate a key's memory in O(1) even for a huge list.
import { Deque } from "./deque.js";

export class StringList extends Deque<string> {
  bytes = 0;

  override pushFront(item: string): void {
    this.bytes += item.length;
    super.pushFront(item);
  }

  override pushBack(item: string): void {
    this.bytes += item.length;
    super.pushBack(item);
  }

  override popFront(): string | undefined {
    const item = super.popFront();
    if (item !== undefined) this.bytes -= item.length;
    return item;
  }

  override popBack(): string | undefined {
    const item = super.popBack();
    if (item !== undefined) this.bytes -= item.length;
    return item;
  }
}

export class StringHash extends Map<string, string> {
  bytes = 0;

  override set(field: string, value: string): this {
    const old = super.get(field);
    if (old !== undefined) this.bytes -= field.length + old.length;
    this.bytes += field.length + value.length;
    return super.set(field, value);
  }

  override delete(field: string): boolean {
    const old = super.get(field);
    if (old === undefined) return false;
    this.bytes -= field.length + old.length;
    return super.delete(field);
  }
}

export class StringSet extends Set<string> {
  bytes = 0;

  override add(member: string): this {
    if (!super.has(member)) this.bytes += member.length;
    return super.add(member);
  }

  override delete(member: string): boolean {
    if (!super.has(member)) return false;
    this.bytes -= member.length;
    return super.delete(member);
  }
}

export type Value = string | StringList | StringHash | StringSet;

// Estimated memory for one key, in bytes. JS can't measure one object's size,
// so this adds up the characters plus a fixed overhead per key and per item
// (object headers, pointers, hash table slots). The overheads come from
// measuring V8's heap growth with 100k-1M keys of each type. A list item is a
// slot in an array; a hash field or set member is an entry in a hash table,
// which costs about three times as much.
const KEY_OVERHEAD = 115;
const LIST_ITEM_OVERHEAD = 40;
const HASH_FIELD_OVERHEAD = 120;
const SET_MEMBER_OVERHEAD = 115;

export function sizeOf(key: string, value: Value): number {
  const base = KEY_OVERHEAD + key.length;
  if (typeof value === "string") return base + value.length;
  if (value instanceof StringList) return base + value.bytes + value.length * LIST_ITEM_OVERHEAD;
  if (value instanceof StringHash) return base + value.bytes + value.size * HASH_FIELD_OVERHEAD;
  return base + value.bytes + value.size * SET_MEMBER_OVERHEAD;
}
