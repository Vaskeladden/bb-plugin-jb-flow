import { useEffect, useRef, useState } from "react";
import {
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_SidebarNavigationIcon as SidebarNavigationIcon,
  experimental_useSidebarNavigationSplit as useNavigationSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useSdk,
  useSettings,
  type ExperimentalSidebarNavigationItem,
  type ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";
import {
  inWorkspace,
  pluginInWorkspace,
  workspaceForThread,
  type Workspace,
} from "./workspaces";
import {
  useWorkspaces,
  useSelectedWorkspace,
  selectWorkspace,
  setWorkspacesEnabled,
  switchWorkspace,
  rememberWorkspaceThread,
} from "./workspace-client";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Checkbox } from "./components/ui/checkbox";
import { Icon } from "./components/ui/icon";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { WORKSPACE_BAR_EVENT } from "./workspace-topbar";
import "./workspaces.css";

const isCatchUpPanel = (item: ExperimentalSidebarNavigationItem) =>
  item.action.kind === "open-plugin-panel" && item.action.pluginId === "jb-flow" && item.action.panelId === "catch-up";

function NavItem({
  item,
  projectId,
}: {
  item: ExperimentalSidebarNavigationItem;
  projectId: string | undefined;
}) {
  const { actions, activeItemId } = useSidebarNavigation();
  const split = useNavigationSplit(item.id);
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="jf-workspace-tool"
      disabled={item.isDisabled || item.isLoading}
      aria-current={activeItemId === item.id ? "page" : undefined}
      aria-label={
        item.badge ? `${item.label}: ${item.badge.label}` : item.label
      }
      title={item.label}
      aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
      {...split.splitProps}
      onClick={(event) => {
        if (
          item.action.kind === "new-thread" &&
          projectId &&
          !event.metaKey &&
          !event.ctrlKey
        )
          navigate.toCompose({ projectId, focusPrompt: true });
        else
          actions.activate(item.id, {
            openInSplit: event.metaKey || event.ctrlKey,
          });
      }}
    >
      <SidebarNavigationIcon icon={item.icon} className="size-4" />
      <span>{item.label}</span>
      {item.badge && (
        <span className="jf-workspace-badge" title={item.badge.label} data-tone={item.badge.tone ?? "neutral"}>
          {item.badge.count !== undefined ? (item.badge.count > 99 ? "99+" : item.badge.count) : (item.badge.text ?? "●")}
        </span>
      )}
    </button>
  );
}

/** The bar and all workspace filtering only run with the Workspaces setting on. */
export function WorkspaceTopBar() {
  const { values, isLoading } = useSettings();
  const enabled = values?.workspaces === true;
  useEffect(() => {
    if (!isLoading) setWorkspacesEnabled(enabled);
  }, [enabled, isLoading]);
  return enabled ? <WorkspaceTopBarInner /> : null;
}

function WorkspaceTopBarInner() {
  const { state, ready, error, refresh } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const { threads, projects } = useSidebarThreads();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_BAR_EVENT, { detail: true }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_BAR_EVENT, { detail: false }),
      );
    };
  }, []);
  useEffect(() => {
    const tabs = tabsRef.current;
    if (!tabs) return;
    const revealSelected = () =>
      tabs
        .querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    revealSelected();
    const observer = new ResizeObserver(revealSelected);
    observer.observe(tabs);
    return () => observer.disconnect();
  }, [selected, ready]);
  const active = state.workspaces.find(
    (workspace) => workspace.id === selected,
  );
  useEffect(() => {
    if (ready && selected && selected !== "unassigned" && !active)
      selectWorkspace(null);
  }, [ready, selected, active]);
  const choose = (id: string | null) =>
    switchWorkspace(id, { state, threads, projects, currentThreadId: context.threadId, navigate });
  const summary = (id: string | null) => {
    const scoped = threads.filter((thread) =>
      inWorkspace(thread, id, state, threads),
    );
    const visible = scoped.filter(
      (thread) =>
        !thread.isArchived &&
        !thread.isHidden &&
        (thread.parentThreadId === null ||
          !scoped.some((parent) => parent.id === thread.parentThreadId)),
    );
    const attention = visible.filter(
      (thread) =>
        thread.hasPendingInteraction ||
        thread.indicator === "waiting-for-input" ||
        thread.indicator === "unread-error" ||
        (thread.isUnread && thread.status === "idle"),
    ).length;
    return { total: visible.length, attention };
  };
  // Until the first workspace exists, All and No workspace would show the same
  // threads; the bar shows only the way to create one.
  const tabs =
    ready && state.workspaces.length === 0
      ? []
      : [
          ...state.workspaces.map((workspace) => ({
            id: workspace.id as string | null,
            name: workspace.name,
          })),
          { id: null, name: "All" },
          { id: "unassigned", name: NO_WORKSPACE },
        ];
  return (
    <header
      className="jf-workspace-topbar"
      aria-label="Workspace navigation"
      title="Workspaces group projects, threads, sections and tools. All keeps everything within reach."
    >
      <div
        role="tablist"
        aria-label="Workspaces"
        className="jf-workspace-tabs"
        ref={tabsRef}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            ),
          );
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {tabs.map((tab) => {
          const counts = summary(tab.id);
          const description = `${counts.total} thread${counts.total === 1 ? "" : "s"} · ${counts.attention} ${counts.attention === 1 ? "needs" : "need"} attention`;
          return (
            <button
              type="button"
              role="tab"
              aria-label={tab.name}
              aria-description={description}
              title={`${tab.name}: ${description}`}
              aria-selected={selected === tab.id}
              tabIndex={selected === tab.id ? 0 : -1}
              key={tab.id ?? "all"}
              className={
                tab.id === null ? "jf-workspace-global-tab" : undefined
              }
              onClick={() => choose(tab.id)}
            >
              {tab.name}
              <span className="jf-workspace-tab-count" aria-hidden="true">
                {ready ? counts.total : "—"}
              </span>
              {counts.attention > 0 && (
                <i className="jf-workspace-attention" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      {ready && state.workspaces.length === 0 ? (
        <WorkspaceManager mode="first" />
      ) : (
        <>
          <WorkspaceManager mode="new" />
          <WorkspaceManager mode="manage" />
        </>
      )}
      {error && (
        <button
          type="button"
          className="jf-workspace-retry"
          onClick={() => void refresh()}
        >
          Retry workspaces
        </button>
      )}
    </header>
  );
}

/** With Workspaces off, BB's own navigation renders unchanged. */
export function WorkspaceNavigation(props: ExperimentalSidebarNavigationProps) {
  const { values } = useSettings();
  if (values?.workspaces !== true) {
    const Original = props.experimental_Original;
    return <Original />;
  }
  return <WorkspaceNavigationInner {...props} />;
}

function WorkspaceNavigationInner(
  _props: ExperimentalSidebarNavigationProps,
) {
  const { state, ready, error, refresh } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const { items, actions } = useSidebarNavigation();
  const { projects } = useSidebarThreads();
  const catchUpOn = useSettings().values?.catchUp === true;
  const [more, setMore] = useState(false);
  const active = state.workspaces.find(
    (workspace) => workspace.id === selected,
  );
  const projectId = active?.projectIds.find((id) =>
    projects.some((project) => project.id === id),
  );
  const scoped = items.filter(
    (item) =>
      pluginInWorkspace(item.pluginId, selected, state) &&
      // bb's own rail still lists the panel (a panel can't hide itself); this list can.
      (catchUpOn || !isCatchUpPanel(item)),
  );
  return (
    <div className="jf-workspaces">
      {error && (
        <p role="alert" className="jf-workspace-error">
          Couldn’t load workspaces.{" "}
          <button type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      )}
      {!ready && !error && <p role="status">Loading workspaces…</p>}
      <div className="jf-workspace-tools">
        {scoped
          .filter((item) => item.isVisible)
          .map((item) => (
            <NavItem key={item.id} item={item} projectId={projectId} />
          ))}
      </div>
      <div className="jf-workspace-footer">
        <button
          type="button"
          onClick={() => setMore(!more)}
          aria-expanded={more}
          aria-label="More tools"
          title="More tools"
        >
          <Icon name={more ? "ChevronUp" : "ChevronDown"} className="jf-workspace-more-icon size-4" />
          <span className="jf-workspace-more-label">More tools</span>
        </button>
        <button
          type="button"
          onClick={() => actions.openCustomize()}
          aria-label="Customise navigation"
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </button>
      </div>
      {more && (
        <div className="jf-workspace-tools" aria-label="All other tools">
          {items
            .filter((item) => !scoped.includes(item) || !item.isVisible)
            .map((item) => (
              <NavItem key={item.id} item={item} projectId={projectId} />
            ))}
        </div>
      )}
    </div>
  );
}

export function WorkspaceRouteBridge() {
  const { state, ready } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const { threadId } = useBbContext();
  const { threads } = useSidebarThreads();
  const previous = useRef<{ id: string; owner: string | null } | null>(null);
  useEffect(() => {
    if (!ready || !threadId) return;
    const thread = threads.find((thread) => thread.id === threadId);
    if (!thread) return;
    const owner = workspaceForThread(thread, state, threads);
    if (previous.current?.id === threadId && previous.current.owner === owner)
      return;
    previous.current = { id: threadId, owner };
    if (!inWorkspace(thread, selected, state, threads))
      selectWorkspace(owner ?? "unassigned");
    rememberWorkspaceThread(owner, threadId);
    rememberWorkspaceThread(null, threadId);
  }, [ready, threadId, threads, state, selected]);
  return null;
}

/** Shown for threads and tools outside every workspace (id "unassigned"). */
export const NO_WORKSPACE = "No workspace";

/**
 * "first": no workspaces yet, a labelled call to action. "new": a + that opens
 * the dialog on a blank workspace. "manage": the settings gear.
 */
function WorkspaceManager({ mode }: { mode: "first" | "new" | "manage" }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {mode === "first" ? (
          <button
            type="button"
            className="jf-workspace-first"
            title="Workspaces group projects, threads, sections and tools into tabs"
          >
            <Icon name="Plus" className="size-4" /> Create your first workspace
          </button>
        ) : mode === "new" ? (
          <button
            type="button"
            className="jf-workspace-manage"
            aria-label="New workspace"
            title="New workspace"
          >
            <Icon name="Plus" className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            className="jf-workspace-manage"
            aria-label="Manage workspaces"
            title="Manage workspaces"
          >
            <Icon name="Settings" className="size-4" />
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="jf-workspace-dialog">
        <div className="jf-workspace-dialog-heading">
          <DialogTitle>Workspaces</DialogTitle>
          <DialogDescription>
            A workspace is a tab of related projects. Pick its projects, and its
            threads, sections and tools follow.
          </DialogDescription>
        </div>
        <WorkspaceSettings startNew={mode !== "manage"} />
      </DialogContent>
    </Dialog>
  );
}

type MembershipField = "projectIds" | "sectionIds" | "pluginIds";
const emptyWorkspace = (): Workspace => ({
  id: "",
  name: "",
  projectIds: [],
  sectionIds: [],
  pluginIds: [],
  sectionOrder: [],
});

export function WorkspaceSettings({ startNew = false }: { startNew?: boolean } = {}) {
  const { state, ready, error, rpc, refresh } = useWorkspaces();
  const selected = useSelectedWorkspace();
  const { projects, sections } = useSidebarThreads();
  const { items } = useSidebarNavigation();
  const sdk = useSdk();
  const [catalog, setCatalog] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  useEffect(() => {
    let mounted = true;
    void sdk.plugins.list().then(
      (result) => {
        if (mounted)
          setCatalog(
            result.plugins
              .filter((plugin) => plugin.enabled && plugin.id !== "jb-flow")
              .map((plugin) => ({
                id: plugin.id,
                name: plugin.name ?? plugin.id,
              })),
          );
      },
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [sdk]);
  const [editing, setEditing] = useState<Workspace | null>(startNew ? emptyWorkspace() : null);
  const [viewedId, setViewedId] = useState(selected);
  // Nothing to manage yet: open straight on a new workspace.
  useEffect(() => {
    if (ready && state.workspaces.length === 0 && editing === null) setEditing(emptyWorkspace());
  }, [ready, state.workspaces.length, editing]);
  const [field, setField] = useState<MembershipField>("projectIds");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const active =
    editing ??
    state.workspaces.find((workspace) => workspace.id === viewedId) ??
    state.workspaces[0];
  const plugins = [
    ...new Map([
      ...items
        .filter((item) => item.pluginId && item.pluginId !== "jb-flow")
        .map(
          (item) =>
            [item.pluginId!, { id: item.pluginId!, name: item.label }] as const,
        ),
      ...catalog.map((plugin) => [plugin.id, plugin] as const),
    ]).values(),
  ];
  const groups = [
    {
      field: "projectIds",
      title: "Projects",
      entries: projects,
      hint: "Projects and their threads belong to one workspace.",
    },
    {
      field: "sectionIds",
      title: "Sections",
      entries: sections,
      hint: "Sections and their threads belong to one workspace.",
    },
    {
      field: "pluginIds",
      title: "Tools",
      entries: plugins,
      hint: "Tools can belong to several workspaces. Tools in no workspace are shared everywhere.",
    },
  ] as const;
  const group = groups.find((group) => group.field === field)!;
  const entries = group.entries.filter((entry) =>
    entry.name.toLowerCase().includes(query.toLowerCase()),
  );
  function edit(workspace: Workspace) {
    setViewedId(workspace.id);
    setEditing({ ...workspace });
    setMessage(null);
    setConfirmRemove(false);
    setQuery("");
  }
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await refresh();
      setEditing(null);
      setConfirmRemove(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  if (!ready) return <p role="status">{error ?? "Loading workspaces…"}</p>;
  return (
    <div className="jf-workspace-settings" aria-busy={busy}>
      <nav className="jf-workspace-list" aria-label="Workspace settings">
        <span className="jf-workspace-list-label">Your workspaces</span>
        {state.workspaces.map((workspace) => (
          <button
            type="button"
            key={workspace.id}
            disabled={busy}
            aria-label={`Edit ${workspace.name}`}
            aria-current={active?.id === workspace.id ? "true" : undefined}
            onClick={() => edit(workspace)}
          >
            <span className="jf-workspace-monogram">
              {workspace.name.slice(0, 1).toUpperCase()}
            </span>
            <span>{workspace.name}</span>
          </button>
        ))}
        <button
          type="button"
          className="jf-workspace-create"
          disabled={busy}
          onClick={() => edit(emptyWorkspace())}
        >
          <Icon name="Plus" className="size-4" /> New workspace
        </button>
      </nav>
      {active ? (
        <form
          className="jf-workspace-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const saved = await rpc.call("workspace_save", {
                ...active,
                id: active.id || null,
              });
              setViewedId(saved.id);
            });
          }}
        >
          <div className="jf-workspace-editor-heading">
            <label htmlFor="jf-workspace-name">Workspace name</label>
            <Input
              id="jf-workspace-name"
              required
              maxLength={60}
              value={active.name}
              disabled={busy}
              placeholder="e.g. Client work"
              onChange={(event) =>
                setEditing({ ...active, name: event.target.value })
              }
            />
          </div>
          <div
            className="jf-membership-tabs"
            role="group"
            aria-label="Workspace content"
          >
            {groups.map((group) => (
              <button
                type="button"
                key={group.field}
                aria-pressed={field === group.field}
                onClick={() => {
                  setField(group.field);
                  setQuery("");
                }}
              >
                {group.title}
                <span>{active[group.field].length}</span>
              </button>
            ))}
          </div>
          <div className="jf-membership-body">
            <p className="jf-membership-hint">{group.hint}</p>
            <div className="jf-membership-search">
              <Icon name="Search" className="size-4" />
              <Input
                aria-label={`Search ${group.title.toLowerCase()}`}
                placeholder={`Search ${group.title.toLowerCase()}…`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div
              className="jf-membership-list"
              role="group"
              aria-label={group.title}
            >
              {entries.map((entry) => {
                const owner =
                  field !== "pluginIds"
                    ? state.workspaces.find(
                        (workspace) =>
                          workspace.id !== active.id &&
                          workspace[field].includes(entry.id),
                      )
                    : undefined;
                return (
                  <label className="jf-membership-row" key={entry.id}>
                    <Checkbox
                      checked={active[field].includes(entry.id)}
                      disabled={busy}
                      onCheckedChange={() =>
                        setEditing({
                          ...active,
                          [field]: active[field].includes(entry.id)
                            ? active[field].filter((id) => id !== entry.id)
                            : [...active[field], entry.id],
                        })
                      }
                    />
                    <span>{entry.name}</span>
                    {owner && (
                      <small
                        title={`Selecting this moves it from ${owner.name}`}
                      >
                        {owner.name}
                      </small>
                    )}
                  </label>
                );
              })}
              {entries.length === 0 && (
                <p className="jf-membership-empty">
                  {query
                    ? "No matches found."
                    : `No ${group.title.toLowerCase()} yet.`}
                </p>
              )}
            </div>
          </div>
          {message && (
            <p role="alert" className="jf-workspace-error">
              {message}
            </p>
          )}
          <div className="jf-workspace-editor-footer">
            {active.id && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="jf-workspace-remove"
                disabled={busy}
                onClick={() => setConfirmRemove(!confirmRemove)}
              >
                Remove workspace
              </Button>
            )}
            <div className="jf-workspace-save-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy || !editing}
                onClick={() => {
                  setEditing(null);
                  setMessage(null);
                  setConfirmRemove(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !editing || !active.name.trim()}
              >
                {busy ? "Saving…" : "Save workspace"}
              </Button>
            </div>
          </div>
          {confirmRemove && (
            <div className="jf-workspace-remove-confirm">
              <p>
                Remove {active.name}? Your threads, projects and sections will
                be kept.
              </p>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    rpc.call("workspace_remove", { id: active.id }),
                  )
                }
              >
                Confirm removal
              </Button>
            </div>
          )}
        </form>
      ) : (
        <div className="jf-workspace-empty">
          <Icon name="Layers" className="size-6" />
          <p>Create a workspace to organise your work.</p>
        </div>
      )}
    </div>
  );
}
