// A set of keys you can also pick a random key from, all in O(1).
// Used by active expiry and by eviction, which both sample random keys.
//
// You can't pick a random key from a JS Map or Set without walking through it,
// so the keys also live in an array, with a map from key to its position.
// Removing a key moves the last key into its slot, so nothing has to shift.
export class RandomKeySet {
  private keys: string[] = [];
  private positions = new Map<string, number>();

  get size(): number {
    return this.keys.length;
  }

  has(key: string): boolean {
    return this.positions.has(key);
  }

  add(key: string): void {
    if (this.positions.has(key)) return;
    this.positions.set(key, this.keys.length);
    this.keys.push(key);
  }

  delete(key: string): boolean {
    const position = this.positions.get(key);
    if (position === undefined) return false;
    const last = this.keys.pop()!;
    if (last !== key) {
      this.keys[position] = last; // move the last key into the freed slot
      this.positions.set(last, position);
    }
    this.positions.delete(key);
    return true;
  }

  random(): string | undefined {
    if (this.keys.length === 0) return undefined;
    return this.keys[Math.floor(Math.random() * this.keys.length)];
  }

  clear(): void {
    this.keys.length = 0;
    this.positions.clear();
  }
}
