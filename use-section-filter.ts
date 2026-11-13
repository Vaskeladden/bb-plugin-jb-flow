import { useCallback, useEffect, useState } from "react";
import { isFiltering, isOnlyShown, onlyShowing, parseStoredSet, shownValues, toggled } from "./section-filter";

export const SECTION_FILTER_KEY = "jb-flow:triage:hidden-sections";

export function useSectionFilter(values: readonly string[]) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => {
    try { return parseStoredSet(localStorage.getItem(SECTION_FILTER_KEY), []); }
    catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(SECTION_FILTER_KEY, JSON.stringify([...hidden])); }
    catch { /* Storage may be disabled; keep the current session usable. */ }
  }, [hidden]);
  const isOn = useCallback((value: string) => !hidden.has(value), [hidden]);
  return {
    filtering: isFiltering(values, hidden),
    shown: shownValues(values, hidden),
    isOn,
    isOnly: (value: string) => isOnlyShown(values, hidden, value),
    toggle: (value: string) => setHidden((current) => toggled(current, value)),
    only: (value: string) => setHidden(onlyShowing(values, value)),
    showAll: () => setHidden(new Set()),
  };
}
