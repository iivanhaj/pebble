// Exact LRU order: the classic hash map + doubly linked list.
//
//   most recent                                        least recent
//   head <-> [key c] <-> [key a] <-> [key d] <-> [key b] <-> tail
//
// The list keeps keys in order of last use. The map finds any key's node
// without walking the list. So every operation is O(1):
//   touch(key):  unlink the node and put it at the front
//   remove(key): unlink the node
//   oldest():    the node at the back
//
// (A JS Map remembers insertion order, so delete + set would also work as an
// LRU. This spells the structure out, since it's the thing being learned.)
type Node = { key: string; prev: Node | null; next: Node | null };

export class LruList {
  private nodes = new Map<string, Node>();
  private head: Node | null = null; // most recently used
  private tail: Node | null = null; // least recently used

  get size(): number {
    return this.nodes.size;
  }

  // Marks the key as just used, adding it if it's new.
  touch(key: string): void {
    let node = this.nodes.get(key);
    if (node) {
      if (node === this.head) return;
      this.unlink(node);
    } else {
      node = { key, prev: null, next: null };
      this.nodes.set(key, node);
    }
    this.pushFront(node);
  }

  remove(key: string): boolean {
    const node = this.nodes.get(key);
    if (!node) return false;
    this.unlink(node);
    this.nodes.delete(key);
    return true;
  }

  // The least recently used key.
  oldest(): string | undefined {
    return this.tail?.key;
  }

  // Keys from most to least recently used (for tests).
  *keys(): Generator<string> {
    for (let node = this.head; node; node = node.next) yield node.key;
  }

  clear(): void {
    this.nodes.clear();
    this.head = this.tail = null;
  }

  private pushFront(node: Node): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private unlink(node: Node): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = node.next = null;
  }
}
