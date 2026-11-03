import { useWorkspaces, useSelectedWorkspace } from "./workspace-client";
import { inWorkspace } from "./workspaces";
// UI built on the plugin's thread state: PR stacks (any repo), running/stuck
// detection, the hover preview, the thread-header status strip, the Pull
// requests panel, and command-palette commands.
import { forwardRef, useCallback, useEffect, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import { experimental_useSidebarThreads as useSidebarThreads, useBbNavigate, useComposers, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { PrStatus } from "./prs";
import { PR_ATTENTION_RANK } from "./palette-model";
import type { FlowState, rpcContract } from "./server";
import type { Unreleased as UnreleasedState } from "./unreleased";
import { parseWhen } from "./when";
import { formatWhen } from "./when";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import type { GlyphName } from "@/components/ui/glyph";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

export const STUCK_AFTER_MS = 15 * 60_000;

// --- PR helpers ------------------------------------------------------------------

export type ThreadPr = Pick<PrStatus, "repo" | "number" | "title" | "url" | "state" | "attention"> & {
  stackedOn: number | null;
};


export const PR_TONE: Record<string, string> = {
  blocked: "text-red-500",
  changes_requested: "text-red-500",
  checks_failed: "text-red-500",
  conflicts: "text-red-500",
  checks_pending: "text-amber-500",
  review_requested: "text-sky-500",
  ready_to_merge: "text-green-500",
  merged: "text-violet-500",
  draft: "text-muted-foreground",
  closed: "text-muted-foreground",
  none: "text-muted-foreground",
};

export function prGlyph(pr: Pick<ThreadPr, "state">): GlyphName {
  return pr.state === "merged" ? "merged" : pr.state === "closed" ? "prClosed" : pr.state === "draft" ? "prDraft" : "pr";
}

export const attentionLabel = (attention: string) => attention.replace(/_/g, " ");

/** Merges the plugin's created-PR list with bb's branch PR, worst first. */
export function threadPrs(
  created: readonly PrStatus[] | undefined,
  branch: { number: number; title: string; url: string; state: string; attention: string } | null,
): ThreadPr[] {
  const prs: ThreadPr[] = [...(created ?? [])];
  if (branch && !prs.some((pr) => pr.url === branch.url)) {
    prs.push({
      repo: /github\.com\/([^/]+\/[^/]+)\//.exec(branch.url)?.[1] ?? "",
      number: branch.number,
      title: branch.title,
      url: branch.url,
      state: branch.state as ThreadPr["state"],
      attention: branch.attention as ThreadPr["attention"],
      stackedOn: null,
    });
  }
  return prs;
}

export function worstPr(prs: readonly ThreadPr[]): ThreadPr | null {
  return [...prs].sort((a, b) => (PR_ATTENTION_RANK[a.attention] ?? 9) - (PR_ATTENTION_RANK[b.attention] ?? 9))[0] ?? null;
}

export const allSettled = (prs: readonly ThreadPr[]) =>
  prs.length > 0 && prs.every((pr) => pr.state === "merged" || pr.state === "closed");

// --- time ------------------------------------------------------------------------

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export type RunInfo = { elapsed: number; silent: number; stuck: boolean };
export function runInfo(running: FlowState["running"][string] | undefined, now: number): RunInfo | null {
  if (!running) return null;
  const silent = now - running.lastEventAt;
  return { elapsed: now - running.since, silent, stuck: silent > STUCK_AFTER_MS };
}

// --- row status icon ---------------------------------------------------------------
// One glyph that answers "what is this thread doing / waiting on?", replacing the
// provider badge. Priority: needs you > error > running > watched > PR > finished.

export type RowStatus = { glyph: GlyphName; tone: string; label: string; spin?: boolean };
export function rowStatus(
  thread: PluginSidebarThread,
  busy: boolean,
  watching: FlowState["watching"][string] | undefined,
  prs: readonly ThreadPr[],
  run: RunInfo | null,
): RowStatus {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") {
    return { glyph: "question", tone: "text-amber-500", label: thread.indicatorLabel ?? "Needs your input" };
  }
  if (thread.status === "error" || thread.indicator === "unread-error") {
    return { glyph: "alert", tone: "text-red-500", label: thread.indicatorLabel ?? "Failed" };
  }
  if (busy && run?.stuck) {
    return { glyph: "alert", tone: "text-amber-500", label: `Possibly stuck: no output for ${duration(run.silent)}` };
  }
  if (busy) return { glyph: "spinner", tone: "text-sky-500", label: run && run.elapsed >= 60_000 ? `Working for ${duration(run.elapsed)}` : "Working", spin: true };
  if (watching?.kind === "ci") return { glyph: "hourglass", tone: "text-sky-500", label: watching.label };
  if (watching?.kind === "release") return { glyph: "rocket", tone: "text-violet-500", label: watching.label };
  if (watching?.kind === "continue") return { glyph: "alarm", tone: "text-amber-500", label: watching.label };
  const worst = worstPr(prs);
  if (worst) {
    const label = prs.length === 1 ? `PR #${worst.number}: ${attentionLabel(worst.attention)}` : `${prs.length} PRs; worst: #${worst.number} ${attentionLabel(worst.attention)}`;
    return { glyph: prGlyph(worst), tone: PR_TONE[worst.attention] ?? "text-muted-foreground", label };
  }
  // Fork: a finished chat looks like any idle one; its bold title already says unread.
  if (thread.isUnread) return { glyph: "dot", tone: "text-muted-foreground/40", label: "Finished, unread" };
  return { glyph: "dot", tone: "text-muted-foreground/40", label: "Idle" };
}

export function StatusIcon({ status }: { status: RowStatus }) {
  return (
    <span title={status.label} aria-label={status.label} className="flex size-4 shrink-0 items-center justify-center">
      <Glyph name={status.glyph} className={cn("size-3.5", status.tone, status.spin && "animate-spin")} />
    </span>
  );
}

// --- PR list (hover card, panel) ---------------------------------------------------

export function PrList({ prs, compact = false }: { prs: readonly ThreadPr[]; compact?: boolean }) {
  const byRepo = new Map<string, ThreadPr[]>();
  for (const pr of prs) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  return (
    <div className="space-y-2">
      {[...byRepo.entries()].map(([repo, list]) => (
        <div key={repo}>
          {byRepo.size > 1 || !compact ? (
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {repo.split("/")[1] ?? repo}
            </div>
          ) : null}
          <ul className="space-y-0.5">
            {list.map((pr) => (
              <li key={pr.url} className={cn("flex items-center gap-1.5 text-xs", pr.stackedOn !== null && "pl-3")}>
                {pr.stackedOn !== null ? <span className="text-muted-foreground">└</span> : null}
                <Glyph name={prGlyph(pr)} className={cn("size-3.5", PR_TONE[pr.attention])} />
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  className="shrink-0 tabular-nums hover:underline"
                >
                  #{pr.number}
                </a>
                <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                <span className={cn("shrink-0 text-[10px]", PR_TONE[pr.attention])}>{attentionLabel(pr.attention)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// --- hover preview -----------------------------------------------------------------

function ago(timestamp: number, now: number): string {
  return `${duration(now - timestamp)} ago`;
}

type HoverPreviewProps = {
  thread: PluginSidebarThread;
  /** The row's status (icon, colour, label), shown first. */
  status: { glyph: GlyphName; tone: string; label: string; spin?: boolean };
  projectName: string | null;
  /** The machine the thread runs on. */
  machineName: string | null;
  sectionName: string | null;
  tags: readonly string[];
  prs: readonly ThreadPr[];
  watching: FlowState["watching"][string] | undefined;
  snoozeUntil: number | undefined;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"a">, "children">;

type Preview = { goal: string; done: string; next: string; blocked: string; latest: string; prompts: number };

function Field({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="flex gap-2 text-xs leading-snug">
      <span className="w-12 shrink-0 pt-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("line-clamp-2 min-w-0 flex-1", tone)}>{children}</span>
    </div>
  );
}

type PreviewCardProps = {
  title: string;
  status: { glyph: GlyphName; tone: string; label: string; spin?: boolean };
  /** Null while it loads. */
  preview: Preview | null;
  prs: readonly ThreadPr[];
  watching: FlowState["watching"][string] | undefined;
  snoozeUntil: number | undefined;
  /** Project, section, branch and so on, shown last. */
  details: readonly string[];
  /** How many PRs to list before "+N more". */
  prLimit?: number;
};

const previews = new Map<string, { updatedAt: number; preview: Preview }>();
const NO_PREVIEW: Preview = { goal: "", done: "", next: "", blocked: "", latest: "", prompts: 0 };

/**
 * A thread's goal, next step, blockers and latest reply, fetched once per
 * update of the thread and shared by the hover card and the palette. Pass a
 * null id to fetch nothing; `delayMs` skips threads you only pass over.
 */
export function useThreadPreview(threadId: string | null, updatedAt: number, delayMs = 0): Preview | null {
  const rpc = useRpc<typeof rpcContract>();
  const cached = threadId === null ? undefined : previews.get(threadId);
  const fresh = cached !== undefined && cached.updatedAt === updatedAt ? cached.preview : null;
  const [loaded, setLoaded] = useState<{ threadId: string; preview: Preview } | null>(null);
  useEffect(() => {
    if (threadId === null || fresh !== null) return;
    let live = true;
    const timer = window.setTimeout(() => {
      rpc.call("thread_preview", { threadId }).then(
        (preview) => {
          previews.set(threadId, { updatedAt, preview });
          if (live) setLoaded({ threadId, preview });
        },
        () => {
          if (live) setLoaded({ threadId, preview: NO_PREVIEW });
        },
      );
    }, delayMs);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [delayMs, fresh, rpc, threadId, updatedAt]);
  if (threadId === null) return null;
  return fresh ?? (loaded?.threadId === threadId ? loaded.preview : null);
}

/** The body of a thread preview, in order of importance: status, goal, next/blocked, PRs, then details. */
export function ThreadPreviewCard({ title, status, preview, prs, watching, snoozeUntil, details, prLimit = 4 }: PreviewCardProps) {
  const shownPrs = prs.slice(0, prLimit);
  return (
    <>
      <div className="space-y-1">
        <div className={cn("flex items-center gap-1.5 text-[11px] font-medium", status.tone)}>
          <Glyph name={status.glyph} className={cn("size-3.5", status.spin && "animate-spin")} />
          <span className="truncate">{status.label}</span>
          {snoozeUntil !== undefined ? (
            <span className="ml-auto shrink-0 font-normal text-muted-foreground">snoozed · {formatWhen(snoozeUntil)}</span>
          ) : null}
        </div>
        <div className="text-sm font-medium leading-snug">{title}</div>
      </div>

      {preview === null ? (
        <div className="h-10 animate-pulse rounded-md bg-muted/60" />
      ) : (
        <div className="space-y-1.5">
          {preview.goal ? <Field label="Goal">{preview.goal}</Field> : null}
          {preview.blocked ? (
            <Field label="Blocked" tone="text-amber-600">
              {preview.blocked}
            </Field>
          ) : null}
          {preview.next ? <Field label="Next">{preview.next}</Field> : null}
          {!preview.next && !preview.blocked && preview.latest ? (
            <Field label="Latest" tone="text-muted-foreground">
              {preview.latest}
            </Field>
          ) : null}
        </div>
      )}

      {watching && !status.label.startsWith(watching.label) ? (
        <div className="text-[11px] text-muted-foreground">{watching.label}</div>
      ) : null}

      {shownPrs.length > 0 ? (
        <div className="space-y-0.5 border-t border-border pt-2">
          {shownPrs.map((pr) => (
            <div key={pr.url} className={cn("flex items-center gap-1.5 text-xs", pr.stackedOn !== null && "pl-3")}>
              <Glyph name={prGlyph(pr)} className={cn("size-3.5", PR_TONE[pr.attention])} />
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {prs.some((other) => other.repo !== pr.repo) ? `${pr.repo.split("/")[1]}#` : "#"}
                {pr.number}
              </span>
              <span className="min-w-0 flex-1 truncate">{pr.title}</span>
              <span className={cn("shrink-0 text-[10px]", PR_TONE[pr.attention])}>{attentionLabel(pr.attention)}</span>
            </div>
          ))}
          {prs.length > shownPrs.length ? (
            <div className="text-[11px] text-muted-foreground">+{prs.length - shownPrs.length} more</div>
          ) : null}
        </div>
      ) : null}

      <div className="truncate border-t border-border pt-2 text-[10px] text-muted-foreground">{details.join(" · ")}</div>
    </>
  );
}

/**
 * Wraps a row in a hover card. Forwards the ref and any props (event handlers
 * from an outer `asChild` trigger such as the context menu) to the row
 * element, so wrapping never swallows right-click or keyboard handling.
 */
export const ThreadHoverPreview = forwardRef<HTMLAnchorElement, HoverPreviewProps>(function ThreadHoverPreview(
  { thread, status, projectName, machineName, sectionName, tags, prs, watching, snoozeUntil, children, ...triggerProps },
  ref,
) {
  // Portaled to <body>: these attributes put the card inside the plugin's CSS scope.
  const portalScope = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  // A right-click opens the row's context menu; the card would cover it. Stay
  // closed until the pointer leaves the row.
  const [suppressed, setSuppressed] = useState(false);
  const preview = useThreadPreview(open ? thread.id : null, thread.updatedAt);

  const details = [
    projectName === "Personal" ? null : projectName,
    sectionName,
    machineName ? `on ${machineName}` : null,
    thread.environment?.branchName ? `⎇ ${thread.environment.branchName}` : null,
    `updated ${duration(Date.now() - thread.updatedAt)} ago`,
    preview && preview.prompts > 0 ? `${preview.prompts} prompts` : null,
    ...tags.map((tag) => `#${tag}`),
  ].filter((detail): detail is string => Boolean(detail));

  return (
    <HoverCard.Root open={open} onOpenChange={(next) => setOpen(next && !suppressed)} openDelay={1000} closeDelay={60}>
      <HoverCard.Trigger
        asChild
        {...triggerProps}
        onContextMenu={(event) => {
          setSuppressed(true);
          setOpen(false);
          triggerProps.onContextMenu?.(event);
        }}
        onPointerLeave={(event) => {
          setSuppressed(false);
          triggerProps.onPointerLeave?.(event);
        }}
        ref={ref}
      >
        {children}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          {...portalScope}
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          className="z-50 w-[26rem] max-w-[calc(100vw-2rem)] space-y-2.5 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg"
        >
          <ThreadPreviewCard
            title={thread.displayTitle}
            status={status}
            preview={preview}
            prs={prs}
            watching={watching}
            snoozeUntil={snoozeUntil}
            details={details}
          />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
});

// --- thread header status strip -----------------------------------------------------

export function HeaderStatusStrip({
  threadId,
  state,
  branchPr,
}: {
  threadId: string;
  state: FlowState | null;
  branchPr: Parameters<typeof threadPrs>[1];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow();
  if (state === null) return null;
  const prs = threadPrs(state.threadPrs[threadId], branchPr);
  const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  const worst = worstPr(open.length ? open : prs);
  const run = runInfo(state.running[threadId], now);
  const watching = state.watching[threadId];
  const chip = "flex h-6 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-accent";

  return (
    <div className="flex items-center gap-0.5">
      {run ? (
        run.stuck ? (
          <button
            type="button"
            className={cn(chip, "text-amber-600")}
            title={`No output for ${duration(run.silent)}. Click to stop the run.`}
            onClick={() => void rpc.call("thread_stop", { threadId })}
          >
            <Glyph name="alert" className="size-3.5" /> stuck {duration(run.silent)}
          </button>
        ) : (
          <span className={cn(chip, "text-sky-600 hover:bg-transparent")} title="Running">
            <Glyph name="spinner" className="size-3.5 animate-spin" /> {duration(run.elapsed)}
          </span>
        )
      ) : null}
      {watching ? (
        <span className={cn(chip, "text-muted-foreground hover:bg-transparent")} title={watching.label}>
          <Glyph name={watching.kind === "ci" ? "hourglass" : watching.kind === "release" ? "rocket" : "alarm"} className="size-3.5" />
          {watching.kind === "ci" ? "CI" : watching.kind === "release" ? "release" : "continue"}
        </span>
      ) : null}
      {worst ? (
        <button
          type="button"
          className={cn(chip, PR_TONE[worst.attention])}
          title={prs.map((pr) => `${pr.repo}#${pr.number} · ${attentionLabel(pr.attention)} · ${pr.title}`).join("\n")}
          onClick={() => navigate.openThreadPanel({ actionId: "prs", title: "Pull requests" })}
        >
          <Glyph name={prGlyph(worst)} className="size-3.5" />
          {prs.length === 1 ? `#${worst.number}` : `${prs.length} PRs`}
        </button>
      ) : null}
    </div>
  );
}

// --- Pull requests panel -------------------------------------------------------------

export function PullRequestsPanel({
  threadId,
  state,
  branchPr,
}: {
  threadId: string;
  params?: JsonValue | null;
  state: FlowState | null;
  branchPr: Parameters<typeof threadPrs>[1];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const prs = threadPrs(state?.threadPrs[threadId], branchPr);
  const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");

  const act = async (fn: () => Promise<string>) => {
    setPending(true);
    try {
      setMessage(await fn());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="jf-side-panel jf-pr-panel space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {prs.length === 0
            ? "No pull requests yet. Linked PRs will appear here automatically."
            : `${prs.length} PR${prs.length === 1 ? "" : "s"} · ${open.length} open`}
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(async () => (await rpc.call("pr_refresh", null), "Refreshed."))}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || open.length === 0}
            onClick={() =>
              act(async () => {
                const { watching } = await rpc.call("thread_watch_ci", { threadId });
                return `Watching ${watching.join(", ")}. This thread gets a message when checks finish or reviews arrive.`;
              })
            }
          >
            Watch CI
          </Button>
        </div>
      </div>
      {prs.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <PrList prs={prs} />
        </div>
      ) : null}
      <form
        className="jf-pr-link-form flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim() === "") return;
          void act(async () => {
            await rpc.call("pr_link", { threadId, url: url.trim(), remove: false });
            setUrl("");
            return "Linked.";
          });
        }}
      >
        <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Paste a GitHub pull request URL" aria-label="PR URL to link" />
        <Button type="submit" size="sm" disabled={pending || url.trim() === ""}>
          Link
        </Button>
      </form>
      {message ? <p role="status" className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

// --- decision chips (composer banner) ---------------------------------------------------
// When the agent's last message ends with numbered options, offer them as
// one-click replies above the composer. Sends just the number.

export { DecisionChips } from "./decision-choices";

// --- Your move (homepage) ---------------------------------------------------------------

/** `lead` sits above the list (the Catch up line), whatever the list shows. */
export function YourMoveSection({ lead = null }: { lead?: ReactNode } = {}) {
  const { state: workspaceState } = useWorkspaces();
  const selectedWorkspace = useSelectedWorkspace();
  const { threads: workspaceThreads } = useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [items, setItems] = useState<Array<{ threadId: string; title: string; since: number; ask: string }> | null>(null);
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => {
    rpc.call("your_move", null).then((result) => setItems(result.items), () => setItems([]));
  }, [rpc]);
  useEffect(load, [load]);
  // Answered threads drop off without leaving the page.
  useRealtime("jb-flow-changed", load);
  if (items === null) return <>{lead}<p className="text-sm text-muted-foreground">Loading…</p></>;
  const scopedItems = items.filter((item) => {
    const thread = workspaceThreads.find((thread) => thread.id === item.threadId);
    return selectedWorkspace === null || (thread !== undefined && inWorkspace(thread, selectedWorkspace, workspaceState, workspaceThreads));
  });
  if (scopedItems.length === 0) return <>{lead}<p className="text-sm text-muted-foreground">No decisions waiting on you.</p></>;
  const now = Date.now();
  const stale = scopedItems.filter((item) => now - item.since > 3 * 86_400_000).length;
  const shown = showAll ? scopedItems : scopedItems.slice(0, 8);
  return (
    <div className="jf-home jf-your-move space-y-2">
      {lead}
      <p className="text-xs text-muted-foreground">
        {scopedItems.length} thread{scopedItems.length === 1 ? "" : "s"} where the agent handed the next step to you, oldest first
        {stale > 0 ? ` · ${stale} waiting 3+ days` : ""}.
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {shown.map((item) => {
          const age = now - item.since;
          return (
            <li key={item.threadId} className="group flex items-start gap-3 px-3 py-2">
              <span
                className={cn(
                  "mt-0.5 w-10 shrink-0 text-right text-xs tabular-nums",
                  age > 3 * 86_400_000 ? "font-medium text-amber-600" : "text-muted-foreground",
                )}
              >
                {duration(age)}
              </span>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate.toThread(item.threadId)}>
                <div className="truncate text-sm font-medium group-hover:underline">{item.title}</div>
                {item.ask ? <div className="jf-home-summary line-clamp-2 text-xs text-muted-foreground">{item.ask}</div> : null}
              </button>
              <div className="jf-home-row-actions flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void rpc.call("snooze", { threadId: item.threadId, when: "3d", note: null, until: parseWhen("3d") }).then(load)}
                >
                  Snooze 3d
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void rpc.call("archive", { threadIds: [item.threadId] }).then(load)}>
                  Archive
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {scopedItems.length > shown.length ? (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowAll(true)}>
          Show all {scopedItems.length}
        </button>
      ) : null}
    </div>
  );
}

// --- Unreleased (homepage) ----------------------------------------------------------------


const shortAge = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

// BB hands homepage sections the project from the URL, which is null on the
// global New Thread page. The project picked in the composer lives in the
// new-thread composer's scope.
function useComposeProject(fallback: string | null): string | null {
  for (const { scope } of useComposers()) if (scope.kind === "new-thread") return scope.projectId ?? fallback;
  return fallback;
}

export function UnreleasedSection({ projectId: routeProjectId }: { projectId: string | null }) {
  const projectId = useComposeProject(routeProjectId);
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<UnreleasedState | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const load = (refresh: boolean) => {
    if (projectId === null) return;
    setLoading(true);
    rpc
      .call("unreleased", { projectId, refresh })
      .then(setData, () => setData(null))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setData(null);
    setShowAll(false);
    load(false);
  }, [rpc, projectId]);
  if (projectId === null) return <p className="text-sm text-muted-foreground">Pick a project to see what's unreleased.</p>;
  if (data === null) return <p className="text-sm text-muted-foreground">{loading ? "Checking GitHub…" : "Couldn't load."}</p>;
  if (data.error !== null) return <p className="text-sm text-muted-foreground">{data.error}</p>;
  const now = Date.now();
  const shown = showAll ? data.prs : data.prs.slice(0, 8);
  const since = data.baseKind === "tag" ? `since ${data.base}` : `not yet on ${data.base}`;
  return (
    <div className="jf-home jf-unreleased space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <p className="min-w-0 flex-1">
          {data.prs.length === 0 ? (
            <>Nothing unreleased on {data.head}: it matches {data.base}.</>
          ) : (
            <>
              {data.prs.length} PR{data.prs.length === 1 ? "" : "s"} on {data.head} {since}
              {data.directCommits > 0 ? ` (+${data.directCommits} direct commit${data.directCommits === 1 ? "" : "s"})` : ""}
            </>
          )}
          {data.releasedAt !== null ? ` · last release ${shortAge(now - data.releasedAt)} ago` : ""}
          {data.compareUrl ? (
            <>
              {" · "}
              <a href={data.compareUrl} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                compare
              </a>
            </>
          ) : null}
        </p>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => load(true)}>
          <Icon name="RotateCcw" className={cn("size-3.5", loading && "animate-spin")} /> Refresh
        </Button>
      </div>
      {shown.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {shown.map((pr) => (
            <li key={pr.number}>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="group flex items-baseline gap-3 px-3 py-2 hover:bg-muted/50"
              >
                <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">#{pr.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm group-hover:underline">{pr.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{pr.author}</span>
                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {pr.mergedAt !== null ? shortAge(now - pr.mergedAt) : ""}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {data.prs.length > shown.length ? (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowAll(true)}>
          Show all {data.prs.length}
        </button>
      ) : null}
    </div>
  );
}
