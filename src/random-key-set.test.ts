import { test } from "node:test";
import assert from "node:assert/strict";
import { RandomKeySet } from "./random-key-set.js";

test("add, has, delete, size; adding twice is a no-op", () => {
  const set = new RandomKeySet();
  set.add("a");
  set.add("b");
  set.add("a");
  assert.equal(set.size, 2);
  assert.ok(set.has("a"));
  assert.equal(set.delete("a"), true);
  assert.equal(set.delete("a"), false);
  assert.ok(!set.has("a"));
  assert.equal(set.size, 1);
});

test("random() only returns keys that are in the set", () => {
  const set = new RandomKeySet();
  assert.equal(set.random(), undefined);
  for (const key of ["a", "b", "c", "d"]) set.add(key);
  set.delete("b"); // from the middle
  set.delete("a"); // from the front
  for (let i = 0; i < 100; i++) assert.ok(["c", "d"].includes(set.random()!));
});

test("stays consistent over 10,000 random adds and deletes", () => {
  const set = new RandomKeySet();
  const model = new Set<string>();
  for (let step = 0; step < 10_000; step++) {
    const key = `k${Math.floor(Math.random() * 50)}`;
    if (Math.random() < 0.5) {
      set.add(key);
      model.add(key);
    } else {
      assert.equal(set.delete(key), model.delete(key));
    }
    assert.equal(set.size, model.size);
    if (model.size > 0) assert.ok(model.has(set.random()!));
  }
});

test("random() reaches every key", () => {
  const set = new RandomKeySet();
  for (let i = 0; i < 10; i++) set.add(`k${i}`);
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(set.random()!);
  assert.equal(seen.size, 10);
});
