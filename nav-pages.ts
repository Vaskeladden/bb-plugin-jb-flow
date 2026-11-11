// The sidebar's pages (dashboards, Studio, Automations…) for the Cmd+K
// palette. bb hands them only to the sidebar navigation component, so that
// component publishes them here and the palette reads them.
import { useSyncExternalStore } from "react";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";

export type NavPage = { id: string; label: string };
type Activate = (itemId: string) => void;

let pages: readonly NavPage[] = [];
let activate: Activate | null = null;
const listeners = new Set<() => void>();

/** Pages a search can open: everything but New thread and Search. */
export function publishNavPages(items: readonly ExperimentalSidebarNavigationItem[], open: Activate): void {
  activate = open;
  const next = items
    .filter((item) => item.id !== "__bb__/new-thread" && item.id !== "__bb__/search-threads")
    .map((item) => ({ id: item.id, label: item.label }));
  if (JSON.stringify(next) === JSON.stringify(pages)) return;
  pages = next;
  for (const listener of listeners) listener();
}

export function openNavPage(id: string): void {
  activate?.(id);
}

export function useNavPages(): readonly NavPage[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pages,
  );
}
