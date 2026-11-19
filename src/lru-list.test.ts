import { test } from "node:test";
import assert from "node:assert/strict";
import { LruList } from "./lru-list.js";

test("keeps keys in order of last use", () => {
  const lru = new LruList();
  lru.touch("a");
  lru.touch("b");
  lru.touch("c");
  assert.deepEqual([...lru.keys()], ["c", "b", "a"]);
  assert.equal(lru.oldest(), "a");

  lru.touch("a"); // used again: moves to the front
  assert.deepEqual([...lru.keys()], ["a", "c", "b"]);
  assert.equal(lru.oldest(), "b");
});

test("remove from the front, middle and back", () => {
  const lru = new LruList();
  for (const key of ["a", "b", "c", "d"]) lru.touch(key); // d c b a
  assert.equal(lru.remove("c"), true); // middle
  assert.equal(lru.remove("d"), true); // front
  assert.equal(lru.remove("a"), true); // back
  assert.equal(lru.remove("a"), false);
  assert.deepEqual([...lru.keys()], ["b"]);
  assert.equal(lru.oldest(), "b");
  lru.remove("b");
  assert.equal(lru.oldest(), undefined);
  assert.equal(lru.size, 0);
});

test("matches a simple array model over 10,000 random operations", () => {
  const lru = new LruList();
  let model: string[] = []; // most recent first
  for (let step = 0; step < 10_000; step++) {
    const key = `k${Math.floor(Math.random() * 30)}`;
    if (Math.random() < 0.7) {
      lru.touch(key);
      model = [key, ...model.filter((k) => k !== key)];
    } else {
      assert.equal(lru.remove(key), model.includes(key));
      model = model.filter((k) => k !== key);
    }
    assert.equal(lru.size, model.length);
    assert.equal(lru.oldest(), model.at(-1));
  }
  assert.deepEqual([...lru.keys()], model);
});
