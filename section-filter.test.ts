import assert from "node:assert/strict";
import test from "node:test";
import { isFiltering, isOnlyShown, onlyShowing, parseStoredSet, shownValues, toggled } from "./section-filter.ts";

test("a stored choice is read back; nothing stored or a broken value gives the dashboard's default", () => {
  assert.deepEqual([...parseStoredSet('["a","b"]', ["x"])], ["a", "b"]);
  assert.deepEqual([...parseStoredSet("[]", ["x"])], [], "an empty stored choice stays empty");
  assert.deepEqual([...parseStoredSet(null, ["x"])], ["x"]);
  assert.deepEqual([...parseStoredSet("not json", ["x"])], ["x"]);
  assert.deepEqual([...parseStoredSet('{"a":1}', [])], []);
  assert.deepEqual([...parseStoredSet('["a",2,null]', [])], ["a"]);
});

test("toggling turns a value off, then on again, without touching the old set", () => {
  const start = new Set(["b"]);
  const off = toggled(start, "a");
  assert.deepEqual([...off].sort(), ["a", "b"]);
  assert.deepEqual([...toggled(off, "a")], ["b"]);
  assert.deepEqual([...start], ["b"]);
});

test("«Bare» hides every other listed value and makes that value the only one", () => {
  const values = ["a", "b", "c"];
  const hidden = onlyShowing(values, "b");
  assert.deepEqual([...hidden].sort(), ["a", "c"]);
  assert.deepEqual(shownValues(values, hidden), ["b"]);
  assert.equal(isOnlyShown(values, hidden, "b"), true);
  assert.equal(isOnlyShown(values, hidden, "a"), false);
  assert.equal(isOnlyShown(values, new Set(), "b"), false);
});

test("filtering counts only values listed now, so a stale stored value does not show «Vis alle»", () => {
  assert.equal(isFiltering(["a", "b"], new Set(["gone"])), false);
  assert.equal(isFiltering(["a", "b"], new Set(["a"])), true);
  assert.equal(isFiltering([], new Set(["a"])), false);
});
