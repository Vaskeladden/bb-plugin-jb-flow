// The sidebar's section order: one list for every view, changed only by the
// user. Views show a subset (a workspace hides sections without live threads),
// so every move works on the full list and a hidden section keeps its place.

/** The saved order, without sections that no longer exist, plus new ones next to their predecessor. */
export function mergeOrder(saved: readonly string[], all: readonly string[]): string[] {
  const result = saved.filter((key, index) => all.includes(key) && saved.indexOf(key) === index);
  all.forEach((key, index) => {
    if (result.includes(key)) return;
    const previous = all.slice(0, index).reverse().find((candidate) => result.includes(candidate));
    result.splice(previous === undefined ? 0 : result.indexOf(previous) + 1, 0, key);
  });
  return result;
}

/** A dragged section dropped before or after another; null when either is not in the order. */
export function dropKey(order: readonly string[], key: string, target: string, after: boolean): string[] | null {
  if (key === target || !order.includes(key)) return null;
  const rest = order.filter((candidate) => candidate !== key);
  const index = rest.indexOf(target);
  if (index === -1) return null;
  rest.splice(after ? index + 1 : index, 0, key);
  return rest;
}

/** Move up or down past the next section the user can see; hidden ones keep their place. */
export function stepKey(order: readonly string[], visible: ReadonlySet<string>, key: string, delta: -1 | 1): string[] | null {
  const shown = order.filter((candidate) => visible.has(candidate));
  const neighbour = shown[shown.indexOf(key) + delta];
  if (!shown.includes(key) || neighbour === undefined) return null;
  return dropKey(order, key, neighbour, delta === 1);
}

/** Whether the saved order lacks a section that exists, so the merged order should be written once. */
export function needsFreeze(saved: readonly string[], merged: readonly string[]): boolean {
  return merged.some((key) => !saved.includes(key));
}
