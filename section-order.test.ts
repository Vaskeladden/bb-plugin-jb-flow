import { expect, it } from "vitest";
import { dropKey, mergeOrder, needsFreeze, stepKey } from "./section-order";

const all = ["research", "infra", "errors", "bugs", "shipit", "__active"];

it("keeps the saved order and places a new section after its predecessor", () => {
  expect(mergeOrder(["bugs", "research", "infra", "errors", "__active"], all)).toEqual(["bugs", "shipit", "research", "infra", "errors", "__active"]);
  expect(mergeOrder(["gone", "bugs", "bugs"], ["bugs"])).toEqual(["bugs"]);
});

it("keeps a hidden section's place when a visible one is dragged", () => {
  // errors has no live threads in this workspace, so it is not shown.
  const order = ["research", "infra", "errors", "bugs", "shipit", "__active"];
  expect(dropKey(order, "bugs", "research", false)).toEqual(["bugs", "research", "infra", "errors", "shipit", "__active"]);
  expect(dropKey(order, "bugs", "bugs", true)).toBeNull();
  expect(dropKey(order, "bugs", "missing", true)).toBeNull();
});

it("steps past the next visible section and leaves hidden ones where they are", () => {
  const order = ["research", "infra", "errors", "bugs", "__active"];
  const visible = new Set(["research", "infra", "bugs", "__active"]);
  expect(stepKey(order, visible, "bugs", -1)).toEqual(["research", "bugs", "infra", "errors", "__active"]);
  expect(stepKey(order, visible, "infra", 1)).toEqual(["research", "errors", "bugs", "infra", "__active"]);
  expect(stepKey(order, visible, "research", -1)).toBeNull();
  expect(stepKey(order, visible, "errors", 1)).toBeNull();
});

it("writes the order once when a section exists that the saved order lacks", () => {
  expect(needsFreeze(["a", "b"], ["a", "b"])).toBe(false);
  expect(needsFreeze(["a"], ["a", "b"])).toBe(true);
  // A deleted section alone does not trigger a write.
  expect(needsFreeze(["a", "gone"], ["a"])).toBe(false);
});
