// A double-ended queue: add and remove at both ends in O(1). Used for lists.
//
// Why not a plain array? array.unshift() and array.shift() move every other
// item, so LPUSH/LPOP on a long list would be O(n) each.
//
// How: items live in a fixed-size array used as a circle. `head` is where the
// first item is; the rest follow it, wrapping around past the end. When the
// array is full, it's copied into one twice the size.
//
//   capacity 8, head 6, length 4:   [ c, d, _, _, _, _, a, b ]   -> a b c d
export class Deque<T> {
  private items: (T | undefined)[] = new Array(8);
  private head = 0;
  length = 0;

  pushFront(item: T): void {
    this.growIfFull();
    this.head = this.wrap(this.head - 1);
    this.items[this.head] = item;
    this.length++;
  }

  pushBack(item: T): void {
    this.growIfFull();
    this.items[this.wrap(this.head + this.length)] = item;
    this.length++;
  }

  popFront(): T | undefined {
    if (this.length === 0) return undefined;
    const item = this.items[this.head];
    this.items[this.head] = undefined; // let the item be garbage collected
    this.head = this.wrap(this.head + 1);
    this.length--;
    return item;
  }

  popBack(): T | undefined {
    if (this.length === 0) return undefined;
    const index = this.wrap(this.head + this.length - 1);
    const item = this.items[index];
    this.items[index] = undefined;
    this.length--;
    return item;
  }

  // The item at position i, counting from the front (0 = first).
  at(i: number): T | undefined {
    if (i < 0 || i >= this.length) return undefined;
    return this.items[this.wrap(this.head + i)];
  }

  private wrap(index: number): number {
    const capacity = this.items.length;
    return ((index % capacity) + capacity) % capacity; // also handles -1
  }

  private growIfFull(): void {
    if (this.length < this.items.length) return;
    const bigger: (T | undefined)[] = new Array(this.items.length * 2);
    for (let i = 0; i < this.length; i++) bigger[i] = this.at(i);
    this.items = bigger;
    this.head = 0;
  }
}
