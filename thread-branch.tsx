import { useId } from "react";
import type { ReactNode } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/ui/icon";
import { Glyph } from "./components/ui/glyph";
import { flattenThreadTree, type ThreadNode } from "./thread-tree";

export function ThreadBranch({ node, renderRow, isCollapsed, toggle, needsAttention, filtered = false }: {
  node: ThreadNode;
  renderRow: (thread: PluginSidebarThread, summary: ReactNode) => ReactNode;
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  needsAttention: (thread: PluginSidebarThread) => boolean;
  filtered?: boolean;
}) {
  const childrenId = useId();
  const descendants = flattenThreadTree(node.children);
  const collapsed = !filtered && isCollapsed(`thread:${node.thread.id}`);
  const running = descendants.filter((thread) => thread.status === "active" || thread.status === "starting").length;
  const attention = descendants.filter(needsAttention).length;
  const unread = descendants.filter((thread) => thread.isUnread).length;
  const label = [
    `${descendants.length} child thread${descendants.length === 1 ? "" : "s"}`,
    running ? `${running} running` : null,
    attention ? `${attention} need attention` : null,
    unread ? `${unread} unread` : null,
  ].filter(Boolean).join(" · ");
  const summary = descendants.length ? (
    <span className="jf-child-summary" title={label} aria-label={label}>
      <span>{descendants.length}</span>
      {running > 0 ? <span className="jf-child-running" aria-hidden="true"><Glyph name="spinner" className="size-3 animate-spin" />{running}</span> : null}
      {attention > 0 ? <span className="jf-child-attention" aria-hidden="true"><Glyph name="alert" className="size-3" />{attention}</span> : null}
      {unread > 0 ? <span className="jf-child-unread" aria-hidden="true" /> : null}
    </span>
  ) : null;
  return (
    <li className="jf-thread-branch" data-jb-flow-branch={node.thread.id}>
      <div className="jf-thread-branch-heading" onKeyDown={(event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target as HTMLElement;
        if (target.dataset.sidebarThreadId !== node.thread.id) return;
        if (event.key === "ArrowRight" && descendants.length) {
          event.preventDefault();
          if (collapsed) toggle(`thread:${node.thread.id}`);
          else document.getElementById(childrenId)?.querySelector<HTMLAnchorElement>("[data-sidebar-thread-id]")?.focus();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          if (descendants.length && !collapsed && !filtered) toggle(`thread:${node.thread.id}`);
          else event.currentTarget.closest("li")?.parentElement?.closest("li")?.querySelector<HTMLAnchorElement>("[data-sidebar-thread-id]")?.focus();
        }
      }}>
        {descendants.length ? (
          <button type="button" className="jf-thread-disclosure"
            aria-label={`${collapsed ? "Expand" : "Collapse"} child threads of ${node.thread.displayTitle}`}
            aria-expanded={!collapsed} aria-controls={childrenId}
            disabled={filtered}
            onClick={() => toggle(`thread:${node.thread.id}`)}>
            <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3" />
          </button>
        ) : null}
        {renderRow(node.thread, summary)}
      </div>
      {descendants.length ? (
        <ul id={childrenId} hidden={collapsed} className="jf-thread-children" aria-label={`Child threads of ${node.thread.displayTitle}`}>
          {!collapsed && node.children.map((child) => <ThreadBranch key={child.thread.id} node={child} renderRow={renderRow} isCollapsed={isCollapsed} toggle={toggle} needsAttention={needsAttention} filtered={filtered} />)}
        </ul>
      ) : null}
    </li>
  );
}
