import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type ThreadNode = {
  thread: PluginSidebarThread;
  children: ThreadNode[];
};

/** Keep parentage across worktrees and sections, in the caller's stable order. */
export function buildThreadTree(threads: readonly PluginSidebarThread[]): ThreadNode[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const children = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    const parent = thread.parentThreadId;
    if (parent && parent !== thread.id && byId.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(thread);
      children.set(parent, siblings);
    }
  }
  const seen = new Set<string>();
  const visit = (thread: PluginSidebarThread): ThreadNode => {
    seen.add(thread.id);
    return {
      thread,
      children: (children.get(thread.id) ?? [])
        .filter((child) => !seen.has(child.id))
        .map(visit),
    };
  };
  const roots = threads
    .filter((thread) => !thread.parentThreadId || !byId.has(thread.parentThreadId) || thread.parentThreadId === thread.id)
    .map(visit);
  // A stale/cyclic parent link must not hide a whole family or recurse forever.
  for (const thread of threads) if (!seen.has(thread.id)) roots.push(visit(thread));
  return roots;
}

/** A matching child keeps its ancestors as context, without unrelated siblings. */
export function filterThreadTree(nodes: readonly ThreadNode[], matches: (thread: PluginSidebarThread) => boolean): ThreadNode[] {
  return nodes.flatMap((node) => {
    const children = filterThreadTree(node.children, matches);
    return matches(node.thread) || children.length ? [{ thread: node.thread, children }] : [];
  });
}

export function flattenThreadTree(nodes: readonly ThreadNode[]): PluginSidebarThread[] {
  return nodes.flatMap((node) => [node.thread, ...flattenThreadTree(node.children)]);
}

export function indexThreadTree(nodes: readonly ThreadNode[]): Map<string, ThreadNode> {
  const result = new Map<string, ThreadNode>();
  const visit = (node: ThreadNode) => {
    result.set(node.thread.id, node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return result;
}
