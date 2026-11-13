// Sidebar visibility follows the dashboard chip rules: a set of hidden values.
// Pure functions shared by the browser hook and unit tests.

/** A stored hidden set; missing, unreadable or not a list of strings gives the dashboard's default. */
export function parseStoredSet(raw: string | null, fallback: readonly string[]): Set<string> {
  if (raw === null) return new Set(fallback);
  try {
    const stored: unknown = JSON.parse(raw);
    return Array.isArray(stored) ? new Set(stored.filter((v): v is string => typeof v === "string")) : new Set(fallback);
  } catch {
    return new Set(fallback);
  }
}

/** The hidden set with one value turned on or off. */
export function toggled(hidden: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(hidden);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** «Bare»: every listed value hidden except this one. */
export function onlyShowing(values: readonly string[], value: string): Set<string> {
  return new Set(values.filter((other) => other !== value));
}

/** The listed values that are on. */
export function shownValues(values: readonly string[], hidden: ReadonlySet<string>): string[] {
  return values.filter((value) => !hidden.has(value));
}

/** Whether this value is the only listed one still on. */
export function isOnlyShown(values: readonly string[], hidden: ReadonlySet<string>, value: string): boolean {
  const shown = shownValues(values, hidden);
  return shown.length === 1 && shown[0] === value;
}

/** Whether any listed value is off; hidden values no longer listed do not count. */
export function isFiltering(values: readonly string[], hidden: ReadonlySet<string>): boolean {
  return values.some((value) => hidden.has(value));
}
