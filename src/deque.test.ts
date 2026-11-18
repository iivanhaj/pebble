import { test } from "node:test";
import assert from "node:assert/strict";
import { Deque } from "./deque.js";

const contents = <T>(deque: Deque<T>) => Array.from({ length: deque.length }, (_, i) => deque.at(i));

test("push and pop at both ends", () => {
  const d = new Deque<string>();
  d.pushBack("b");
  d.pushFront("a");
  d.pushBack("c");
  assert.deepEqual(contents(d), ["a", "b", "c"]);
  assert.equal(d.popFront(), "a");
  assert.equal(d.popBack(), "c");
  assert.equal(d.popBack(), "b");
  assert.equal(d.popBack(), undefined);
  assert.equal(d.popFront(), undefined);
  assert.equal(d.length, 0);
});

test("grows past its starting size, from either end", () => {
  const d = new Deque<number>();
  for (let i = 0; i < 20; i++) d.pushFront(i);
  for (let i = 0; i < 20; i++) d.pushBack(100 + i);
  assert.equal(d.length, 40);
  assert.equal(d.at(0), 19);
  assert.equal(d.at(19), 0);
  assert.equal(d.at(20), 100);
  assert.equal(d.at(39), 119);
  assert.equal(d.at(40), undefined);
  assert.equal(d.at(-1), undefined);
});

test("matches a plain array over 10,000 random operations", () => {
  const d = new Deque<number>();
  const model: number[] = [];
  for (let step = 0; step < 10_000; step++) {
    const op = Math.floor(Math.random() * 4);
    if (op === 0) { d.pushFront(step); model.unshift(step); }
    if (op === 1) { d.pushBack(step); model.push(step); }
    if (op === 2) assert.equal(d.popFront(), model.shift(), `step ${step}`);
    if (op === 3) assert.equal(d.popBack(), model.pop(), `step ${step}`);
    assert.equal(d.length, model.length);
  }
  assert.deepEqual(contents(d), model);
});
