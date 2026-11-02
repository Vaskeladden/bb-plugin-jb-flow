import { createWorkspaceStorage } from "./workspace-storage";
import { workspaceSchema, workspaceStateSchema } from "./workspaces";
import { createThreadStatus, threadStatusSchema } from "./thread-status";
import { countSince } from "./catch-up-model";
import { handBackInstructions } from "./status-prompt";
// jb-flow: snooze threads until a date, a daily stale-thread digest, and the
// state behind the Triage thread list in app.tsx.
//
// State lives in bb.storage.kv because thread plugin metadata is not part of
// thread list rows; the sidebar needs every snooze and tag in one read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createActivity } from "./activity";
import { createAwaiting, waitsOnOthers } from "./awaiting";
import { nextMove, parseDecisionOptions } from "./decisions";
import { createLeftovers, leftoverSchema } from "./leftovers";
import { createFocus, focusReportSchema, needsAttention } from "./focus";
import { createPrTracker, prStatusSchema, type PrStatus } from "./prs";
import { createUnreleased, unreleasedSchema } from "./unreleased";
import { laneSections } from "./lanes";
import { createMachines, machinesSchema } from "./machines";
import { createRepoCommands, devRunSchema, repoCommandSchema, repoScriptSchema } from "./repo-commands";
import { formatWhen, parseWhen } from "./when";
import { createWatchers, releaseWatchSchema } from "./watchers";

const SNOOZED_SECTION_NAME = "😴 Snoozed";
const CHANGED = "jb-flow-changed";
const DAY_MS = 86_400_000;

const snoozeSchema = z.object({
  until: z.number(),
  note: z.string().nullable(),
  fromSectionId: z.string().nullable(),
  snoozedAt: z.number(),
});
export type Snooze = z.infer<typeof snoozeSchema>;

const digestItemSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  title: z.string(),
  idleDays: z.number(),
  summary: z.string(),
});
export type DigestItem = z.infer<typeof digestItemSchema>;
type Digest = { generatedAt: number; items: DigestItem[] };

// Machine-local setup: pinned repo commands, how project names are shortened in
// the sidebar, and release watches. Comes from local.config.json in the plugin
// folder (see local.config.example.json) and/or the "Advanced config" setting,
// which wins key by key.
const localConfigSchema = z.object({
  repoCommands: z.record(z.string(), z.array(repoCommandSchema)).default({}),
  projectShortNames: z.record(z.string(), z.string()).default({}),
  stripProjectPrefixes: z.array(z.string()).default([]),
  /** Projects (by BB name) whose release-blocked threads are woken on release. */
  releaseWatch: z.record(z.string(), releaseWatchSchema).default({}),
});
type LocalConfig = z.infer<typeof localConfigSchema>;

function loadLocalConfig(bb: BbPluginApi, settingJson: string): LocalConfig {
  const file = readLocalConfigFile(bb);
  if (!settingJson.trim()) return file;
  try {
    const fromSetting = localConfigSchema.partial().parse(JSON.parse(settingJson));
    return { ...file, ...Object.fromEntries(Object.entries(fromSetting).filter(([, value]) => value !== undefined)) };
  } catch (error) {
    bb.log.warn(`ignoring invalid Advanced config setting: ${String(error)}`);
    return file;
  }
}

function readLocalConfigFile(bb: BbPluginApi): LocalConfig {
  // The bundle may run from the plugin root or from dist/, so try both.
  for (const relative of ["./local.config.json", "../local.config.json"]) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      return localConfigSchema.parse(JSON.parse(text));
    } catch (error) {
      bb.log.warn(`ignoring invalid ${path}: ${String(error)}`);
    }
  }
  return localConfigSchema.parse({});
}

const stateSchema = z.object({
  projectShortNames: z.record(z.string(), z.string()),
  stripProjectPrefixes: z.array(z.string()),
  /** Idle threads whose last agent message hands the next move to you (thread id → since). */
  awaiting: z.record(z.string(), z.number()),
  /** Idle threads whose agent promised to report back by itself (thread id → since). */
  promised: z.record(z.string(), z.number()),
  /** Idle threads whose next step is someone else's (thread id → since). */
  waitingOthers: z.record(z.string(), z.number()),
  /** Your order for non-lane sections (section ids); unlisted ones follow by creation. */
  sectionOrder: z.array(z.string()),
  /** Lane → section id, pinned so renaming a lane's section keeps its role. */
  /** Which machine each thread runs on, for the sidebar's machine filter. */
  machines: machinesSchema,
  laneSections: z.object({ priority: z.string(), waiting: z.string(), later: z.string(), low: z.string() }).partial(),
  /** Per section (section key → project id): where "New thread here" starts threads. */
  sectionProjects: z.record(z.string(), z.string()),
  /** Per thread: every PR it created (any repo), stack-ordered. */
  threadPrs: z.record(z.string(), z.array(prStatusSchema)),
  /** Running threads: run start and last event, for elapsed time and stuck detection. */
  running: z.record(z.string(), z.object({ since: z.number(), lastEventAt: z.number() })),
  /** Per thread: what the plugin is waiting on for it (CI, release, auto-continue). */
  watching: z.record(z.string(), z.object({ kind: z.enum(["ci", "release", "continue"]), label: z.string() })),
  snoozedSectionId: z.string().nullable(),
  snoozes: z.record(z.string(), snoozeSchema),
  tags: z.record(z.string(), z.array(z.string())),
});
export type FlowState = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  workspaces_get: { input: z.null(), output: workspaceStateSchema },
  workspace_save: { input: workspaceSchema.extend({ id: z.string().nullable() }), output: workspaceSchema },
  workspace_remove: { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  workspace_assign: { input: z.object({ threadId: z.string(), workspaceId: z.string().nullable(), automatic: z.boolean() }), output: z.object({ ok: z.boolean() }) },
  state_get: { input: z.null(), output: stateSchema },
  auto_continue_get: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ enabled: z.boolean(), scheduledAt: z.number().nullable() }),
  },
  wakeups_get: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      autoContinue: z.object({ enabled: z.boolean(), scheduledAt: z.number().nullable() }),
      watches: z.array(z.object({ kind: z.enum(["ci", "release"]), key: z.string(), label: z.string() })),
    }),
  },
  wakeup_cancel: {
    input: z.object({ threadId: z.string(), kind: z.enum(["ci", "release"]), key: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  auto_continue_set: {
    input: z.object({ threadId: z.string(), enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean(), scheduledAt: z.number().nullable() }),
  },
  snooze: {
    input: z.object({
      threadId: z.string(),
      when: z.string().min(1).max(64),
      note: z.string().max(2000).nullable(),
      /** `when` resolved in the browser's time zone; the server's may differ (bb Connect). */
      until: z.number().optional(),
    }),
    output: snoozeSchema,
  },
  unsnooze: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  tags_set: {
    input: z.object({
      threadId: z.string(),
      tags: z.array(z.string().trim().min(1).max(40)).max(10),
    }),
    output: z.object({ tags: z.array(z.string()) }),
  },
  digest_list: {
    input: z.object({ refresh: z.boolean() }),
    output: z.object({ generatedAt: z.number(), items: z.array(digestItemSchema) }),
  },
  digest_keep: {
    input: z.object({
      threadIds: z.array(z.string()).max(500),
      days: z.number().int().min(1).max(90),
    }),
    output: z.object({ kept: z.number() }),
  },
  archive: {
    input: z.object({ threadIds: z.array(z.string()).min(1).max(500) }),
    output: z.object({ archived: z.number(), failed: z.array(z.string()) }),
  },
  thread_status: { input: z.object({ threadId: z.string().min(1).max(200), refresh: z.boolean().default(true) }), output: threadStatusSchema.nullable() },
  thread_preview: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      goal: z.string(),
      done: z.string(),
      next: z.string(),
      blocked: z.string(),
      latest: z.string(),
      prompts: z.number(),
    }),
  },
  catch_up_card: {
    input: z.object({ threadId: z.string().min(1).max(200), since: z.number().nullable() }),
    output: z.object({
      since: z.object({
        turns: z.number(),
        yourPrompts: z.number(),
        otherPrompts: z.number(),
        more: z.boolean(),
        firstAt: z.number().nullable(),
      }),
    }),
  },
  thread_stop: { input: z.object({ threadId: z.string() }), output: z.object({ ok: z.boolean() }) },
  thread_watch_ci: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ watching: z.array(z.string()) }),
  },
  pr_link: {
    input: z.object({ threadId: z.string(), url: z.string(), remove: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  pr_refresh: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  next_needs_me: {
    input: z.object({ archiveThreadId: z.string().nullable() }),
    output: z.object({ opened: z.string().nullable() }),
  },
  decision_options: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      mode: z.enum(["go", "choice"]),
      options: z.array(z.object({ n: z.number(), text: z.string(), recommended: z.boolean() })),
    }),
  },
  thread_reply: {
    input: z.object({ threadId: z.string(), text: z.string().min(1).max(2000) }),
    output: z.object({ ok: z.boolean() }),
  },
  your_move: {
    input: z.null(),
    output: z.object({
      items: z.array(
        z.object({ threadId: z.string(), title: z.string(), projectId: z.string(), since: z.number(), ask: z.string() }),
      ),
    }),
  },
  unreleased: {
    input: z.object({ projectId: z.string(), refresh: z.boolean() }),
    output: unreleasedSchema,
  },
  leftovers_get: {
    input: z.object({ refresh: z.boolean() }),
    output: z.object({ checkedAt: z.number(), items: z.array(leftoverSchema) }),
  },
  leftovers_clean: {
    input: z.null(),
    output: z.object({ removed: z.array(z.string()), kept: z.array(z.string()) }),
  },
  section_order_set: {
    input: z.object({ order: z.array(z.string()).max(200) }),
    output: z.object({ ok: z.boolean() }),
  },
  section_project_set: {
    input: z.object({ section: z.string(), projectId: z.string().nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  focus_report: {
    input: focusReportSchema,
    output: z.object({ ok: z.boolean() }),
  },
  repo_status: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      projectName: z.string(),
      commands: z.array(repoCommandSchema),
      scripts: z.array(repoScriptSchema),
      scriptsError: z.string().nullable(),
      runs: z.array(devRunSchema),
    }),
  },
  repo_run: {
    input: z.object({ threadId: z.string(), commandId: z.string() }),
    output: devRunSchema,
  },
  repo_stop: {
    input: z.object({ threadId: z.string(), commandId: z.string() }),
    output: z.object({ stopped: z.boolean() }),
  },
  repo_config_get: {
    input: z.null(),
    output: z.object({
      defaults: z.record(z.string(), z.array(repoCommandSchema)),
      overrides: z.record(z.string(), z.array(repoCommandSchema)),
    }),
  },
  repo_config_set: {
    input: z.object({ projectName: z.string(), commands: z.array(repoCommandSchema).nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  migrate_areas: {
    input: z.object({
      sectionIds: z.array(z.string()).max(20),
      moveToSectionId: z.string().nullable(),
    }),
    output: z.object({ tagged: z.number() }),
  },
});

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    workspaces: {
      type: "boolean",
      label: "Workspaces",
      description:
        "Tabs across the top of BB that group projects, threads, sections and plugin tools. Off shows everything as before.",
      default: true,
    },
    palette: {
      type: "boolean",
      label: "⌘K opens the JB Flow palette",
      description:
        "BB's Search threads key (⌘K unless you changed it) opens a palette that also finds messages, PRs, workspaces and projects, shows what needs you, and acts on any thread with Tab. BB's own search stays under Open quick palette → Search threads. Off gives the key back to BB.",
      default: true,
    },
    catchUp: {
      type: "boolean",
      label: "Catch up",
      description:
        "Go through unread threads one card at a time: mark read, keep unread, reply, snooze or archive. Adds a Catch up page with an unread count, a command (⌥⇧C), a palette action and a line on the home page. Off hides them.",
      default: true,
    },
    polishShell: {
      type: "boolean",
      label: "Polish the entire BB interface",
      description: "Refine the sidebar, composer, conversation, panel tabs and menus across BB. Off restores BB's standard styling.",
      default: true,
    },
    threadMonitor: {
      type: "boolean",
      label: "Thread monitor",
      description:
        "Keep the activity card visible when a thread is idle, with the agent's last status report (Just did, Next step, Goal), progress bars and an Update status button.",
      default: true,
    },
    statusPrompt: {
      type: "string",
      label: "Status report prompt",
      description:
        "What Update status sends to the agent. Leave empty for a short built-in prompt. The monitor reads **Goal:**, **Done:**, **Next:**, **Blocked:** and a ### Progress block.",
      experimental_multiline: true,
      default: "",
    },
    autoStatus: {
      type: "boolean",
      label: "Status report at hand-back",
      description:
        "Ask agents to end replies that hand the thread back to you with the status report above, so the thread monitor stays current without Update status. Threads pick this up when their session next starts.",
      default: false,
    },
    staleDays: {
      type: "number",
      label: "Stale after (days)",
      description: "Unsectioned threads idle this long show up in the daily digest.",
      default: 7,
    },
    autoContinue: {
      type: "boolean",
      label: "Continue after usage-limit resets (default for threads)",
      description:
        "When Claude Code stops on a session limit, send \"continue\" 90 seconds after the limit resets. Each thread can switch it on or off in the thread monitor.",
      default: false,
    },
    expandPlans: {
      type: "boolean",
      label: "Expand plan reviews",
      description: "Plans awaiting approval open expanded. Drag the handle under a plan to set its height.",
      default: true,
    },
    advancedConfig: {
      type: "string",
      label: "Advanced config (JSON)",
      description:
        "releaseWatch, projectShortNames, stripProjectPrefixes and repoCommands, in the local.config.json format from the README. Reload the plugin after a change.",
      experimental_multiline: true,
      default: "",
    },
  });
  let { advancedConfig } = await settings.get();
  // A marketplace update replaces the plugin folder, and local.config.json with
  // it. Copy the file into the setting once, while it's still there.
  if (advancedConfig.trim() === "") {
    const file = readLocalConfigFile(bb);
    const used = Object.entries(file).filter(([, value]) => (Array.isArray(value) ? value.length : Object.keys(value).length) > 0);
    if (used.length > 0) {
      advancedConfig = JSON.stringify(Object.fromEntries(used), null, 2);
      await settings
        .experimental_set({ advancedConfig })
        .then(() => bb.log.info("copied local.config.json into the Advanced config setting; the file is no longer needed"))
        .catch((error) => bb.log.warn(`copying local.config.json failed: ${String(error)}`));
    }
  }
  const localConfig = loadLocalConfig(bb, advancedConfig);

  // --- storage --------------------------------------------------------------

  async function getSnoozes(): Promise<Record<string, Snooze>> {
    return (await bb.storage.kv.get<Record<string, Snooze>>("snoozes")) ?? {};
  }
  async function getTags(): Promise<Record<string, string[]>> {
    return (await bb.storage.kv.get<Record<string, string[]>>("tags")) ?? {};
  }
  async function getKept(): Promise<Record<string, number>> {
    return (await bb.storage.kv.get<Record<string, number>>("kept")) ?? {};
  }
  // One thread event can change several stores within milliseconds; publish
  // once after they settle so every window refetches once, not four times.
  // Async work can finish after a reload disposed this instance; publishing on
  // the stale handle throws inside a timer, which takes the whole BB server down.
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  function changed() {
    if (disposed) return;
    bumpDeck();
    if (publishTimer !== null) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      if (disposed) return;
      try {
        bb.realtime.publish(CHANGED, {});
      } catch (error) {
        bb.log.warn(`publish failed: ${String(error)}`);
      }
    }, 250);
  }
  bb.onDispose(() => {
    disposed = true;
    if (publishTimer !== null) clearTimeout(publishTimer);
  });

  // The Stream Deck long-polls `deck --wait <version>`: the call returns as soon
  // as something it shows may have changed (focus, a thread starting/stopping,
  // plugin state), so switching threads updates the keys at once.
  let deckVersion = 0;
  const deckWaiters = new Set<() => void>();
  function bumpDeck() {
    deckVersion += 1;
    for (const wake of deckWaiters) wake();
    deckWaiters.clear();
  }
  function waitForDeckChange(version: number, timeoutMs: number): Promise<void> {
    if (version !== deckVersion) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        deckWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      deckWaiters.add(done);
    });
  }
  // A thread starting or stopping changes counts too: drop the cached list.
  const onThreadState = ({ thread }: { thread: { id: string } }) => {
    threadListCache = null;
    // Only a thread the cache doesn't know (new, or new environment) can change machines.
    machines.invalidateFor(thread.id);
    bumpDeck();
  };
  bb.events.on("thread.active", onThreadState);
  bb.events.on("thread.idle", onThreadState);
  bb.onDispose(() => {
    for (const wake of deckWaiters) wake();
  });

  // The Snoozed section is created by the first snooze, not on install, so
  // people who never snooze don't get an empty section. Looked up by name and
  // cached briefly; the user may delete or recreate it at any time.
  let snoozedSectionId: string | null = null;
  let snoozedCheckedAt = 0;
  async function findSnoozedSection(): Promise<string | null> {
    if (Date.now() - snoozedCheckedAt < 10_000) return snoozedSectionId;
    const sections = await bb.sdk.threadSections.list();
    snoozedSectionId = sections.find((section) => section.name === SNOOZED_SECTION_NAME)?.id ?? null;
    snoozedCheckedAt = Date.now();
    return snoozedSectionId;
  }
  async function ensureSnoozedSection(): Promise<string> {
    snoozedCheckedAt = 0;
    const existing = await findSnoozedSection();
    if (existing !== null) return existing;
    snoozedSectionId = (await bb.sdk.threadSections.create({ name: SNOOZED_SECTION_NAME })).id;
    snoozedCheckedAt = Date.now();
    return snoozedSectionId;
  }

  async function listAllActiveThreads(): Promise<Thread[]> {
    const threads: Thread[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await bb.sdk.threads.list({ limit: 500, offset });
      // Filter as well: archived/hidden rows must never reach the digest.
      threads.push(
        ...page.filter(
          (thread) => thread.archivedAt === null && thread.deletedAt === null && thread.visibility === "visible",
        ),
      );
      if (page.length < 500) return threads;
    }
  }

  // --- snooze ---------------------------------------------------------------

  // Every snoozes write goes through here: bulk snoozes and the every-minute
  // wake check run concurrently, and a stale read-then-write loses records.
  let snoozeLock: Promise<unknown> = Promise.resolve();
  function updateSnoozes(apply: (snoozes: Record<string, Snooze>) => void): Promise<void> {
    const run = snoozeLock.then(async () => {
      const snoozes = await getSnoozes();
      apply(snoozes);
      await bb.storage.kv.set("snoozes", snoozes);
    });
    snoozeLock = run.catch(() => undefined);
    return run;
  }

  async function snooze(threadId: string, when: string, note: string | null, until?: number): Promise<Snooze> {
    if (until !== undefined && until <= Date.now()) throw new Error(`"${when}" is in the past.`);
    const record = await snoozeUntil(threadId, until ?? parseWhen(when), note);
    return record;
  }

  async function snoozeUntil(
    threadId: string,
    until: number,
    note: string | null,
  ): Promise<Snooze> {
    const sectionId = await ensureSnoozedSection();
    const thread = await bb.sdk.threads.get({ threadId });
    const snoozes = await getSnoozes();
    const previous = snoozes[threadId];
    const record: Snooze = {
      until,
      note: note?.trim() || null,
      // Re-snoozing keeps the section the thread originally came from.
      fromSectionId:
        previous?.fromSectionId ?? (thread.sectionId === sectionId ? null : thread.sectionId),
      snoozedAt: Date.now(),
    };
    await bb.sdk.threads.update({ threadId, sectionId });
    await updateSnoozes((all) => {
      all[threadId] = record;
    });
    changed();
    return record;
  }

  async function wake(threadId: string, record: Snooze, reason: "due" | "manual"): Promise<void> {
    const sections = await bb.sdk.threadSections.list();
    let restoreTo =
      record.fromSectionId !== null &&
      sections.some((section) => section.id === record.fromSectionId)
        ? record.fromSectionId
        : null;
    // Snoozed while waiting on someone ("when it wakes, I'll check for Sam's
    // reply"): wake into Waiting for others instead of the old section.
    // Only for a snooze that ran out; cancelling one puts the thread back where it was.
    const { waiting } = reason === "due" ? await laneSections(bb) : { waiting: null };
    if (waiting) {
      const output = await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
      if (waitsOnOthers(output.output ?? "")) restoreTo = waiting;
    }
    await bb.sdk.threads.update({ threadId, sectionId: restoreTo });
    if (reason === "due") {
      await bb.sdk.threads.markUnread({ threadId });
      if (record.note !== null) {
        await bb.sdk.threads.send({
          threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: `⏰ Snooze reminder: ${record.note}`, mentions: [] }],
        });
      }
    }
  }

  async function unsnooze(threadId: string): Promise<boolean> {
    const snoozes = await getSnoozes();
    const record = snoozes[threadId];
    if (record === undefined) return false;
    await wake(threadId, record, "manual");
    await updateSnoozes((all) => {
      delete all[threadId];
    });
    changed();
    return true;
  }


  async function wakeDue(): Promise<number> {
    const snoozes = await getSnoozes();
    if (Object.keys(snoozes).length === 0) return 0;
    // No section (never created, or deleted): every record below is stale.
    const sectionId = await findSnoozedSection();
    let woken = 0;
    // Removed at the end against a fresh read, keyed by the record we saw, so
    // a snooze set meanwhile (or a re-snooze) survives.
    const done = new Map<string, number>();
    for (const [threadId, record] of Object.entries(snoozes)) {
      let thread: { sectionId: string | null; archivedAt: number | null };
      try {
        thread = await bb.sdk.threads.get({ threadId });
      } catch {
        done.set(threadId, record.snoozedAt);
        continue;
      }
      // Moved out of Snoozed by hand, or archived: the snooze no longer applies.
      if (sectionId === null || thread.sectionId !== sectionId || thread.archivedAt !== null) {
        done.set(threadId, record.snoozedAt);
        continue;
      }
      if (record.until > Date.now()) continue;
      try {
        await wake(threadId, record, "due");
        done.set(threadId, record.snoozedAt);
        woken += 1;
      } catch (error) {
        bb.log.warn(`wake ${threadId} failed: ${String(error)}`);
      }
    }
    if (done.size > 0) {
      await updateSnoozes((all) => {
        for (const [threadId, snoozedAt] of done) if (all[threadId]?.snoozedAt === snoozedAt) delete all[threadId];
      });
      changed();
    }
    return woken;
  }

  // --- digest ---------------------------------------------------------------

  async function summarize(threadId: string): Promise<string> {
    try {
      const outline = await bb.sdk.threads.conversationOutline({ threadId });
      const last =
        [...outline.items].reverse().find((item) => item.role === "assistant") ??
        outline.items.at(-1);
      return (last?.preview ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    } catch {
      return "";
    }
  }

  async function buildDigest(): Promise<Digest> {
    const now = Date.now();
    const kept = await getKept();
    const snoozes = await getSnoozes();
    // Read per build so a changed setting applies without a reload.
    const { staleDays } = await settings.get();
    const stale = (await listAllActiveThreads())
      .filter(
        (thread) =>
          thread.sectionId === null &&
          thread.parentThreadId === null &&
          thread.pinnedAt === null &&
          thread.status !== "active" &&
          snoozes[thread.id] === undefined &&
          (kept[thread.id] ?? 0) < now &&
          now - thread.updatedAt > staleDays * DAY_MS,
      )
      .sort((a, b) => a.updatedAt - b.updatedAt);

    const items: DigestItem[] = [];
    // Small batches keep the outline reads from hammering the server.
    for (let index = 0; index < stale.length; index += 8) {
      const batch = stale.slice(index, index + 8);
      const summaries = await Promise.all(batch.map((thread) => summarize(thread.id)));
      batch.forEach((thread, offset) => {
        items.push({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title ?? thread.titleFallback ?? "Untitled",
          idleDays: Math.floor((now - thread.updatedAt) / DAY_MS),
          summary: summaries[offset] ?? "",
        });
      });
    }
    const digest = { generatedAt: now, items };
    await bb.storage.kv.set("digest", digest);
    changed();
    return digest;
  }

  async function readDigest(refresh: boolean): Promise<Digest> {
    const cached = await bb.storage.kv.get<Digest>("digest");
    if (refresh || cached === null || cached === undefined) return buildDigest();
    const kept = await getKept();
    const now = Date.now();
    return { ...cached, items: cached.items.filter((item) => (kept[item.threadId] ?? 0) < now) };
  }

  async function archive(threadIds: string[]) {
    const failed: string[] = [];
    for (const threadId of threadIds) {
      try {
        await bb.sdk.threads.archive({ threadId });
      } catch {
        failed.push(threadId);
      }
    }
    const cached = await bb.storage.kv.get<Digest>("digest");
    if (cached) {
      const archived = new Set(threadIds.filter((id) => !failed.includes(id)));
      await bb.storage.kv.set("digest", {
        ...cached,
        items: cached.items.filter((item) => !archived.has(item.threadId)),
      });
    }
    changed();
    return { archived: threadIds.length - failed.length, failed };
  }

  // Each thread's own auto-continue switch (thread monitor); absent = the setting.
  const autoContinueOverrides = async () =>
    (await bb.storage.kv.get<Record<string, boolean>>("autoContinueThreads")) ?? {};

  // Late-bound: the awaiting tracker is created below.
  const focus = createFocus(bb, () => awaiting.all(), () => findSnoozedSection());
  const unreleased = createUnreleased(bb);
  const machines = createMachines(bb);
  const prTracker = createPrTracker(bb, changed);
  const watchers = createWatchers(bb, localConfig.releaseWatch, async (threadId) => (await autoContinueOverrides())[threadId] ?? (await settings.get()).autoContinue, changed, async (threadId) =>
    ((await prTracker.byThread())[threadId] ?? []).map(({ repo, state, mergedAt }) => ({ repo, state, mergedAt })),
  );
  const activity = createActivity(bb, changed);
  const threadStatus = createThreadStatus(bb, changed);
  const awaiting = createAwaiting(bb, changed);

  /** Watch every open PR the thread created; fall back to its branch PR. */
  async function watchThreadCi(
    threadId: string,
    options: { pr?: number; repo?: string; watchFor?: "checks" | "reviews" | "both" },
  ) {
    // A bare PR number: use the repo of this thread's own PR with that number.
    if (options.pr !== undefined && options.repo === undefined) {
      const own = ((await prTracker.byThread())[threadId] ?? []).filter((pr) => pr.number === options.pr);
      const repos = [...new Set(own.map((pr) => pr.repo))];
      if (repos.length > 1) throw new Error(`#${options.pr} exists in ${repos.join(" and ")}. Pass repo.`);
      if (repos.length === 1) options = { ...options, repo: repos[0] };
    }
    if (options.pr === undefined) {
      const open = await prTracker.openPrsFor(threadId);
      if (open.length > 0) {
        return Promise.all(open.map((ref) => watchers.watchCi(threadId, { ...options, pr: ref.number, repo: ref.repo })));
      }
    }
    return [await watchers.watchCi(threadId, options)];
  }
  async function watchingByThread() {
    const status = await watchers.status();
    const watching: FlowState["watching"] = {};
    const releaseProjects = new Map<string, string[]>();
    for (const waiter of Object.values(status.releaseWaiters)) {
      releaseProjects.set(waiter.threadId, [...(releaseProjects.get(waiter.threadId) ?? []), waiter.projectName]);
    }
    for (const [threadId, names] of releaseProjects) {
      watching[threadId] = { kind: "release", label: `Waiting for the next ${names.join(" / ")} release` };
    }
    for (const [threadId, entry] of Object.entries(status.autoContinue)) {
      watching[threadId] = { kind: "continue", label: `Limit hit; auto-continues ${formatWhen(entry.resetsAt + 90_000)}` };
    }
    for (const watch of Object.values(status.ciWatches)) {
      watching[watch.threadId] = { kind: "ci", label: `Watching ${watch.repo.split("/")[1]}#${watch.pr} (${watch.watchFor})` };
    }
    return watching;
  }

async function yourMove({ withAsk = true }: { withAsk?: boolean } = {}) {
    const waiting = await awaiting.all();
    const snoozedSection = await findSnoozedSection();
    // One list instead of a get per entry; outputs fetched in parallel below.
    const byId = new Map((await listAllActiveThreads()).map((thread) => [thread.id, thread]));
    const candidates = Object.entries(waiting).flatMap(([threadId, since]) => {
      const thread = byId.get(threadId);
      if (!thread || thread.status !== "idle" || (snoozedSection !== null && thread.sectionId === snoozedSection)) return [];
      return [{ thread, since }];
    });
    const asks = new Map<string, string>();
    if (withAsk) {
      for (let index = 0; index < candidates.length; index += 8) {
        await Promise.all(
          candidates.slice(index, index + 8).map(async ({ thread }) => {
            const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
            // The ask is at the end of the message: show its last meaningful lines.
            const ask = (output.output ?? "")
              .split("\n")
              .map((line) => line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`>#]+/g, "").trim())
              .filter((line) => line.length > 0 && !/^\d{1,2}[./]\d{1,2}[./]\d{2,4}|^\d{4}-\d{2}-\d{2}|^stamped/i.test(line))
              .slice(-3)
              .join(" ")
              .slice(0, 240);
            asks.set(thread.id, ask);
          }),
        );
      }
    }
    const items = candidates.map(({ thread, since }) => ({
      threadId: thread.id,
      title: thread.title ?? thread.titleFallback ?? "Untitled",
      projectId: thread.projectId,
      // Date the ask by the thread's last activity: backfilled entries carry the
      // classification time, not when the agent actually asked.
      since: Math.min(since, thread.updatedAt),
      ask: asks.get(thread.id) ?? "",
    }));
    items.sort((a, b) => a.since - b.since);
    return { items };
  }

  const repo = createRepoCommands(bb, changed, localConfig.repoCommands);
  const leftovers = createLeftovers(bb);

  // --- RPC ------------------------------------------------------------------

  let stateBuild: Promise<FlowState> | null = null;
  async function buildState(): Promise<FlowState> {
    return {
      awaiting: await awaiting.all(),
      promised: await awaiting.promised(),
      waitingOthers: await awaiting.waitingOthers(),
      sectionOrder: (await bb.storage.kv.get<string[]>("sectionOrder")) ?? [],
      sectionProjects: (await bb.storage.kv.get<Record<string, string>>("sectionProjects")) ?? {},
      laneSections: await laneSections(bb),
      machines: await machines.read(),
      threadPrs: await prTracker.byThread(),
      running: activity.snapshot(),
      watching: await watchingByThread(),
      projectShortNames: localConfig.projectShortNames,
      stripProjectPrefixes: localConfig.stripProjectPrefixes,
      snoozedSectionId: await findSnoozedSection(),
      snoozes: await getSnoozes(),
      tags: await getTags(),
    };
  }

  const workspaces = createWorkspaceStorage(bb, changed);
  bb.rpc.register(rpcContract, {
    workspaces_get: () => workspaces.read(),
    workspace_save: (input) => workspaces.save(input),
    workspace_remove: async ({ id }) => { await workspaces.remove(id); return { ok: true }; },
    workspace_assign: async ({ threadId, workspaceId, automatic }) => { await workspaces.assign(threadId, workspaceId, automatic); return { ok: true }; },
    // Concurrent callers (every open window refetches on the same publish) share one build.
    state_get: () => (stateBuild ??= buildState().finally(() => (stateBuild = null))),
    auto_continue_get: async ({ threadId }) => ({
      enabled: (await autoContinueOverrides())[threadId] ?? (await settings.get()).autoContinue,
      scheduledAt: await watchers.autoContinueAt(threadId),
    }),
    wakeups_get: async ({ threadId }) => ({
      autoContinue: {
        enabled: (await autoContinueOverrides())[threadId] ?? (await settings.get()).autoContinue,
        scheduledAt: await watchers.autoContinueAt(threadId),
      },
      watches: await watchers.wakeupsFor(threadId),
    }),
    wakeup_cancel: async ({ threadId, kind, key }) => {
      await watchers.cancelWakeup(threadId, kind, key);
      return { ok: true };
    },
    auto_continue_set: async ({ threadId, enabled }) => {
      const overrides = await autoContinueOverrides();
      overrides[threadId] = enabled;
      await bb.storage.kv.set("autoContinueThreads", overrides);
      // Switched off with a "continue" already queued: take it back.
      if (!enabled) await watchers.cancelAutoContinue(threadId);
      changed();
      return { enabled, scheduledAt: enabled ? await watchers.autoContinueAt(threadId) : null };
    },
    snooze: ({ threadId, when, note, until }) => snooze(threadId, when, note, until),
    unsnooze: async ({ threadId }) => ({ removed: await unsnooze(threadId) }),
    tags_set: async ({ threadId, tags }) => {
      const all = await getTags();
      const unique = [...new Set(tags)];
      if (unique.length === 0) delete all[threadId];
      else all[threadId] = unique;
      await bb.storage.kv.set("tags", all);
      changed();
      return { tags: unique };
    },
    digest_list: ({ refresh }) => readDigest(refresh),
    digest_keep: async ({ threadIds, days }) => {
      const kept = await getKept();
      const until = Date.now() + days * DAY_MS;
      for (const threadId of threadIds) kept[threadId] = until;
      await bb.storage.kv.set("kept", kept);
      changed();
      return { kept: threadIds.length };
    },
    archive: ({ threadIds }) => archive(threadIds),
    thread_status: ({ threadId, refresh }) => threadStatus.get(threadId, refresh),
    thread_preview: async ({ threadId }) => {
      const [output, outline] = await Promise.all([
        bb.sdk.threads.output({ threadId }).catch(() => ({ output: null })),
        bb.sdk.threads.conversationOutline({ threadId }).catch(() => ({ items: [] as Array<{ role: string; preview: string }> })),
      ]);
      const reply = output.output ?? "";
      // Markdown → plain text for one-line display.
      const plain = (text: string) =>
        text
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/[*_`>#]+/g, "")
          .replace(/[\u2580-\u259F\u2500-\u257F]+/g, "")
          .replace(/\s+/g, " ")
          .trim();
      // The user's Status template: "**Goal:** …", "**Next:** …", etc.
      const field = (name: string) => {
        const match = new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, "i").exec(reply);
        return match ? plain(match[1]!).slice(0, 300) : "";
      };
      const userItems = outline.items.filter((item) => item.role === "user");
      const firstLines = reply
        .split("\n")
        .map(plain)
        .filter((line) => line.length > 0 && !/^(goal|done|next|blocked):/i.test(line))
        .slice(0, 4)
        .join(" ");
      return {
        goal: field("Goal") || plain(userItems[0]?.preview ?? "").slice(0, 300),
        done: field("Done"),
        next: field("Next"),
        blocked: field("Blocked"),
        latest: firstLines.slice(0, 400),
        prompts: userItems.length,
      };
    },
    catch_up_card: async ({ threadId, since }) => {
      // The card embeds the thread itself; this adds what happened since you last read it.
      const timeline = await bb.sdk.threads
        .timeline({ threadId, segmentLimit: "8", deferContent: "true", includeNestedRows: "false" })
        .catch(() => null);
      return { since: countSince(timeline?.rows ?? [], since, (timeline?.timelinePage.olderCursor ?? null) !== null) };
    },
    thread_stop: async ({ threadId }) => {
      await bb.sdk.threads.stop({ threadId });
      return { ok: true };
    },
    thread_watch_ci: async ({ threadId }) => ({
      watching: (await watchThreadCi(threadId, { watchFor: "both" })).map((watch) => `${watch.repo}#${watch.pr}`),
    }),
    pr_link: async ({ threadId, url, remove }) => {
      const match = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
      if (!match) throw new Error("Paste a GitHub PR URL, e.g. https://github.com/owner/repo/pull/123");
      await prTracker.link(threadId, { repo: match[1]!, number: Number(match[2]) }, remove);
      return { ok: true };
    },
    pr_refresh: async () => {
      await prTracker.refresh();
      return { ok: true };
    },
    next_needs_me: async ({ archiveThreadId }) => {
      if (archiveThreadId !== null) await bb.sdk.threads.archive({ threadId: archiveThreadId });
      const next = (await focus.needsMe()).find((thread) => thread.id !== archiveThreadId);
      if (next === undefined) return { opened: null };
      await bb.sdk.threads.open({ threadId: next.id, file: null });
      return { opened: next.id };
    },
    decision_options: async ({ threadId }) => {
      const output = await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
      return nextMove(output.output ?? "");
    },
    thread_reply: async ({ threadId, text }) => {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
      return { ok: true };
    },
    your_move: () => yourMove(),
    unreleased: ({ projectId, refresh }) => unreleased(projectId, refresh),
    leftovers_get: ({ refresh }) => leftovers.read(refresh),
    leftovers_clean: () => leftovers.clean(),
    section_order_set: async ({ order }) => {
      await bb.storage.kv.set("sectionOrder", order);
      changed();
      return { ok: true };
    },
    section_project_set: async ({ section, projectId }) => {
      const current = (await bb.storage.kv.get<Record<string, string>>("sectionProjects")) ?? {};
      const { [section]: _previous, ...rest } = current;
      await bb.storage.kv.set("sectionProjects", projectId === null ? rest : { ...rest, [section]: projectId });
      changed();
      return { ok: true };
    },
    focus_report: (input) => {
      const before = focus.focusedThreadId();
      focus.report(input);
      if (focus.focusedThreadId() !== before) bumpDeck();
      return { ok: true };
    },
    repo_status: ({ threadId }) => repo.status(threadId),
    repo_run: ({ threadId, commandId }) => repo.run(threadId, commandId),
    repo_stop: async ({ threadId, commandId }) => ({ stopped: await repo.stop(threadId, commandId) }),
    repo_config_get: () => repo.allCommands(),
    repo_config_set: async ({ projectName, commands }) => {
      await repo.setCommands(projectName, commands);
      return { ok: true };
    },
    migrate_areas: async ({ sectionIds, moveToSectionId }) => {
      const sections = await bb.sdk.threadSections.list();
      const tags = await getTags();
      let tagged = 0;
      for (const sectionId of sectionIds) {
        const section = sections.find((candidate) => candidate.id === sectionId);
        if (section === undefined) continue;
        const tag = section.name.replace(/^[^\p{L}\p{N}]+/u, "").trim();
        const inSection = await bb.sdk.threads.list({ sectionId, limit: 500 });
        for (const thread of inSection.filter((candidate) => candidate.archivedAt === null)) {
          tags[thread.id] = [...new Set([...(tags[thread.id] ?? []), tag])];
          await bb.sdk.threads.update({ threadId: thread.id, sectionId: moveToSectionId });
          tagged += 1;
        }
      }
      await bb.storage.kv.set("tags", tags);
      changed();
      return { tagged };
    },
  });

  // --- schedules ------------------------------------------------------------

  bb.background.schedule("wake-snoozed", "* * * * *", async () => {
    const woken = await wakeDue();
    if (woken > 0) bb.log.info(`woke ${woken} snoozed thread(s)`);
  });
  bb.background.schedule("stale-digest", "0 8 * * 1-5", async () => {
    const digest = await buildDigest();
    bb.log.info(`digest: ${digest.items.length} stale thread(s)`);
    await pruneThreadData().catch((error) => bb.log.warn(`prune: ${String(error)}`));
  });

  // Tags, "keep" marks and dev-server runs are per thread; drop them once the
  // thread is archived or deleted so the stored maps (sent with every state
  // load) stop growing and the tag filter only offers tags still in use.
  async function forgetThreads(isGone: (threadId: string) => boolean) {
    const tags = await getTags();
    const kept = await getKept();
    const runs = (await bb.storage.kv.get<Record<string, { threadId: string }>>("devRuns")) ?? {};
    const continues = await autoContinueOverrides();
    const goneContinues = Object.keys(continues).filter(isGone);
    if (goneContinues.length > 0) {
      for (const threadId of goneContinues) delete continues[threadId];
      await bb.storage.kv.set("autoContinueThreads", continues);
    }
    const goneTags = Object.keys(tags).filter(isGone);
    const goneKept = Object.entries(kept).filter(([threadId, until]) => isGone(threadId) || until < Date.now());
    const goneRuns = Object.entries(runs).filter(([, run]) => isGone(run.threadId));
    if (goneTags.length + goneKept.length + goneRuns.length === 0) return;
    for (const threadId of goneTags) delete tags[threadId];
    for (const [threadId] of goneKept) delete kept[threadId];
    for (const [key] of goneRuns) delete runs[key];
    await bb.storage.kv.set("tags", tags);
    await bb.storage.kv.set("kept", kept);
    await bb.storage.kv.set("devRuns", runs);
    changed();
  }
  async function pruneThreadData() {
    const live = new Set((await listAllActiveThreads()).map((thread) => thread.id));
    await forgetThreads((threadId) => !live.has(threadId));
    await awaiting.prune((threadId) => live.has(threadId));
  }
  bb.events.on("thread.archived", ({ thread }) => forgetThreads((threadId) => threadId === thread.id));

  // --- agent tool -----------------------------------------------------------

  bb.agents.registerTool({
    name: "snooze_thread",
    description:
      'Snooze the current BB thread until a later time. The thread leaves the user\'s active list and comes back unread when due. If a note is given it is sent to this thread as a prompt at wake time, so write it as an instruction to your future self (e.g. "Check whether Martin replied in #billing and summarize").',
    instructions:
      "When work in this thread is blocked on someone else or on a future date, offer to call snooze_thread (when: 2h, 3d, 1w, tomorrow, mon, next-week, or YYYY-MM-DD) with a note describing what to check on wake-up.",
    parameters: z.object({
      when: z
        .string()
        .describe("When to wake: 2h, 3d, 1w, tomorrow, mon…sun, next-week, or YYYY-MM-DD"),
      note: z.string().optional().describe("Instruction sent to this thread when it wakes"),
    }),
    async execute({ when, note }, ctx) {
      try {
        const record = await snooze(ctx.threadId, when, note ?? null);
        return `Snoozed until ${formatWhen(record.until)}${record.note ? ` with reminder: ${record.note}` : ""}.`;
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  });
  bb.agents.registerTool({
    name: "wait_for_ci",
    description:
      "Wait for a GitHub PR's CI checks and/or new reviews/comments without polling. Registers a watch and returns immediately; when checks finish (with the failed log on failure), a review or comment arrives, or the PR merges/closes, a message is sent to this thread once it is idle; nothing is sent while it is still working. End your turn after calling it.",
    instructions:
      "Never poll CI or PR state in loops (no `gh pr checks --watch`, `gh run watch`, `until gh ...; sleep`, or repeated `gh pr view`). After pushing or opening a PR, call wait_for_ci (pr optional: defaults to this branch's PR) and end your turn; you'll be messaged with the result once you're idle. Nothing arrives while you keep working, so check pr_status before relying on a PR's state. For a review loop use for: \"both\".",
    parameters: z.object({
      pr: z.number().int().positive().optional().describe("PR number; defaults to every open PR this thread created (all repos), else this branch's PR"),
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .optional()
        .describe("owner/name of the PR's repo. Needed when the PR is not in this thread's project repo and this thread didn't create it"),
      for: z.enum(["checks", "reviews", "both"]).optional().describe("What to wait for (default both)"),
    }),
    async execute({ pr, repo, for: watchFor }, ctx) {
      try {
        const watches = await watchThreadCi(ctx.threadId, { pr, repo, watchFor });
        return `Watching ${watches.map((watch) => `${watch.repo}#${watch.pr}`).join(", ")} for ${watches[0]!.watchFor}. End your turn now; a message will arrive when there's news.`;
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });
  bb.agents.registerTool({
    name: "pr_status",
    description:
      "State of every PR this thread created (any repo, stack order): checks, review decision, conflicts, draft/merged, base/head. Served from the plugin's cache, refreshed every 3 minutes; pass refresh: true for a live read. Use this instead of gh pr view / gh pr checks to check PR state.",
    instructions:
      "To check the state of this thread's PRs, call pr_status (one call, all repos) instead of gh pr view / gh pr checks. Use gh only to read full review comments or logs.",
    parameters: z.object({
      refresh: z.boolean().optional().describe("Fetch live state first (one batched GitHub query)"),
    }),
    async execute({ refresh }, ctx) {
      if (refresh) {
        await prTracker.scan(ctx.threadId);
        await prTracker.refresh();
      }
      const prs = (await prTracker.byThread())[ctx.threadId] ?? [];
      if (prs.length === 0) return "No PRs linked to this thread. PRs opened with gh pr create are linked automatically; others via `bb jb-flow pr-link <url> --self`.";
      return prs
        .map(
          (pr) =>
            `${pr.stackedOn !== null ? "  └ " : ""}${pr.repo}#${pr.number} [${pr.attention}] ${pr.title} (${pr.head} → ${pr.base}) ${pr.url}`,
        )
        .join("\n");
    },
  });
  // configure() must answer synchronously, so keep the settings it reads at hand.
  let agentSettings = await settings.get();
  settings.onChange((next) => {
    agentSettings = next;
  });
  bb.agents.configure(() => ({
    tools: ["snooze_thread", "wait_for_ci", "pr_status"],
    skills: [],
    ...(agentSettings.autoStatus && agentSettings.threadMonitor
      ? { instructions: handBackInstructions(agentSettings.statusPrompt) }
      : {}),
  }));

  // --- CLI ------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb jb-flow snooze <thread-id|--self> <when> [--note <text>]",
    "  bb jb-flow unsnooze <thread-id|--self>",
    "  bb jb-flow snoozed [--json]",
    "  bb jb-flow wake-now",
    "  bb jb-flow digest [--refresh] [--json]",
    "  bb jb-flow focused [--json]                          The thread focused in BB",
    "  bb jb-flow stop [<thread-id>|--focused]",
    "  bb jb-flow tell <text…> [--thread <id>]              Send a message (default: focused thread)",
    "  bb jb-flow needs-me [--json]                         Threads waiting on you",
    "  bb jb-flow next                                      Open the next thread that needs you",
    "  bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--self|<thread-id>]",
    "  bb jb-flow watches [--json]                          Auto-continues, release waiters, CI watches",
    "  bb jb-flow prs [--self|<thread-id>] [--json]         PRs a thread created (all repos, stack order)",
    "  bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]",
    "  bb jb-flow release-wait [--self|<thread-id>]         Wake this thread on the next release",
    "  bb jb-flow check-now                                 Run the release and CI checks immediately",
    "  bb jb-flow repo [--self|<thread-id>]                 List repo commands and runs",
    "  bb jb-flow repo-run <command-id> [--self|<thread-id>]",
    "  bb jb-flow repo-stop <command-id> [--self|<thread-id>]",
    "  bb jb-flow repo-config <project-name> <json|reset>",
    "",
    "<when>: 30m, 2h, 3d, 1w, today, tonight, tomorrow, mon…sun, next-week, YYYY-MM-DD, YYYY-MM-DDTHH:MM",
  ].join("\n");

  // --- cheap snapshots for external controllers (Stream Deck) ------------------
  // The deck polls every few seconds while agents keep bb busy, so these read
  // cached data: one thread list per 10s, no message bodies except the focused
  // thread's (re-read only when it changes).

  type ListedThread = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];
  let threadListCache: { at: number; threads: Promise<ListedThread[]> } | null = null;
  function listThreadsCached(): Promise<ListedThread[]> {
    if (threadListCache === null || Date.now() - threadListCache.at > 10_000) {
      const threads = bb.sdk.threads.list({ limit: 500 });
      threadListCache = { at: Date.now(), threads };
      threads.catch(() => {
        threadListCache = null;
      });
    }
    return threadListCache.threads;
  }

  async function prRadar() {
    // Threads with an open PR that needs fixing or is ready to merge,
    // skipping threads whose agent is already working on it.
    const byThread = await prTracker.byThread();
    const live = new Map(
      (await listThreadsCached())
        .filter((thread) => thread.archivedAt === null && thread.status !== "active" && thread.status !== "starting")
        .map((thread) => [thread.id, thread]),
    );
    const broken: Array<{ threadId: string; title: string; pr: string }> = [];
    const ready: Array<{ threadId: string; title: string; pr: string }> = [];
    for (const [threadId, prs] of Object.entries(byThread)) {
      const thread = live.get(threadId);
      if (!thread) continue;
      const open = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
      const bad = open.find((pr) => ["checks_failed", "changes_requested", "conflicts"].includes(pr.attention));
      const good = open.find((pr) => pr.attention === "ready_to_merge");
      const entry = (pr: PrStatus) => ({ threadId, title: thread.title ?? "", pr: `${pr.repo.split("/")[1]}#${pr.number}` });
      if (bad) broken.push(entry(bad));
      else if (good) ready.push(entry(good));
    }
    return { broken, ready };
  }

  // Re-parse the focused thread's options only when it changes.
  let decisionCache: { key: string; options: ReturnType<typeof parseDecisionOptions> } | null = null;
  async function decisionsFor(threadId: string | null) {
    const thread = threadId === null ? null : await bb.sdk.threads.get({ threadId }).catch(() => null);
    // Same rule as the composer buttons: only an idle thread is waiting on an answer.
    let options: ReturnType<typeof parseDecisionOptions> = [];
    if (thread !== null && thread.status === "idle") {
      const cacheKey = `${thread.id}:${thread.updatedAt}`;
      if (decisionCache?.key !== cacheKey) {
        const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
        decisionCache = { key: cacheKey, options: parseDecisionOptions(output.output ?? "") };
      }
      options = decisionCache.options;
    }
    return { threadId: thread?.id ?? null, title: thread?.title ?? null, status: thread?.status ?? null, options };
  }

  /** Everything the deck shows, in one call. */
  async function deckSnapshot() {
    const [threads, waiting, radar, focused] = await Promise.all([
      listThreadsCached(),
      awaiting.all(),
      prRadar(),
      decisionsFor(focus.focusedThreadId()),
    ]);
    const open = threads.filter(
      (thread) => thread.archivedAt === null && thread.deletedAt === null && thread.visibility === "visible" && thread.parentThreadId === null,
    );
    const needs = open.filter((thread) => needsAttention(thread, waiting));
    const needIds = new Set(needs.map((thread) => thread.id));
    const moves = open
      .filter((thread) => thread.status === "idle" && waiting[thread.id] !== undefined && !needIds.has(thread.id))
      .map((thread) => Math.min(waiting[thread.id]!, thread.updatedAt));
    return {
      focused,
      needsMe: { count: needs.length },
      yourMove: { count: moves.length, oldestSince: moves.length ? Math.min(...moves) : null },
      prRadar: { broken: radar.broken.length, ready: radar.ready.length },
    };
  }

  bb.cli.register({
    name: "jb-flow",
    summary: "Snooze threads and review the stale-thread digest",
    commands: [
      { name: "workspaces", summary: "List workspaces or save/remove/assign using JSON", usage: 'bb jb-flow workspaces [save <json>|remove <id>|assign <thread-id> <workspace-id|unassigned|auto>]' },
      {
        name: "snooze",
        summary: "Snooze a thread until a time",
        usage: "bb jb-flow snooze <thread-id|--self> <when> [--note <text>]",
      },
      {
        name: "unsnooze",
        summary: "Wake a snoozed thread now",
        usage: "bb jb-flow unsnooze <thread-id|--self>",
      },
      { name: "snoozed", summary: "List snoozed threads", usage: "bb jb-flow snoozed [--json]" },
      { name: "wake-now", summary: "Run the due-snooze check immediately", usage: "bb jb-flow wake-now" },
      { name: "leftovers", summary: "Worktree checkouts bb no longer tracks (--clean removes the merged ones)", usage: "bb jb-flow leftovers [--refresh] [--json] [--clean]" },
      { name: "deck", summary: "One JSON snapshot for the Stream Deck: focused thread, Needs me, Your move, PRs", usage: "bb jb-flow deck [--wait <version>]" },
      { name: "pr-radar", summary: "Threads with a PR to fix or merge (--open: jump to the next one)", usage: "bb jb-flow pr-radar [--json] [--open]" },
      { name: "your-move", summary: "Threads waiting on a decision from you, oldest first", usage: "bb jb-flow your-move [--json] [--open]" },
      { name: "focus-clients", summary: "Debug: the BB windows reporting focus, most recently used first", usage: "bb jb-flow focus-clients" },
      { name: "focused", summary: "Print the thread focused in BB", usage: "bb jb-flow focused [--json]" },
      { name: "decisions", summary: "Numbered options the focused thread is waiting on", usage: "bb jb-flow decisions [<thread-id>] [--json]" },
      { name: "stop", summary: "Stop a thread's run (default: focused)", usage: "bb jb-flow stop [<thread-id>|--focused]" },
      { name: "tell", summary: "Send a message to a thread (default: focused)", usage: "bb jb-flow tell <text…> [--thread <id>]" },
      { name: "needs-me", summary: "List threads waiting on you", usage: "bb jb-flow needs-me [--json]" },
      { name: "next", summary: "Open the next thread that needs you", usage: "bb jb-flow next" },
      { name: "wait-ci", summary: "Message a thread when its PR's CI finishes or reviews arrive", usage: "bb jb-flow wait-ci [--pr <n>] [--for checks|reviews|both] [--self|<thread-id>]" },
      { name: "prs", summary: "List the PRs a thread created, across repos, in stack order", usage: "bb jb-flow prs [--self|<thread-id>] [--json]" },
      { name: "pr-link", summary: "Link (or --remove) a PR to a thread", usage: "bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]" },
      { name: "watches", summary: "List auto-continues, release waiters and CI watches", usage: "bb jb-flow watches [--json]" },
      { name: "release-wait", summary: "Wake a thread on the next release", usage: "bb jb-flow release-wait [--self|<thread-id>]" },
      { name: "check-now", summary: "Run the release and CI checks immediately", usage: "bb jb-flow check-now" },
      { name: "repo", summary: "List repo commands and runs for a thread", usage: "bb jb-flow repo [--self|<thread-id>]" },
      { name: "repo-run", summary: "Run a repo command in the thread's terminal", usage: "bb jb-flow repo-run <command-id> [--self|<thread-id>]" },
      { name: "repo-stop", summary: "Stop a running repo command", usage: "bb jb-flow repo-stop <command-id> [--self|<thread-id>]" },
      { name: "repo-config", summary: "Set or reset a project's repo commands", usage: "bb jb-flow repo-config <project-name> <json|reset>" },
      {
        name: "digest",
        summary: "List stale unsectioned threads",
        usage: "bb jb-flow digest [--refresh] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const refresh = argv.includes("--refresh");
      const noteIndex = argv.indexOf("--note");
      const note = noteIndex === -1 ? null : argv.slice(noteIndex + 1).join(" ");
      const positional = (noteIndex === -1 ? argv : argv.slice(0, noteIndex)).filter(
        (arg) => arg !== "--json" && arg !== "--refresh",
      );
      const [command, ...args] = positional;
      const resolveThread = (value: string | undefined) =>
        value === "--self" ? ctx.threadId : value === "--focused" ? focus.focusedThreadId() ?? undefined : value;
      try {
        switch (command) {
          case "workspaces": {
            if (args[0] === "save") {
              const input = workspaceSchema.extend({ id: z.string().nullable() }).parse(JSON.parse(args.slice(1).join(" ")));
              return { exitCode: 0, stdout: JSON.stringify(await workspaces.save(input)) };
            }
            if (args[0] === "remove" && args[1]) await workspaces.remove(args[1]);
            else if (args[0] === "assign" && args[1] && args[2]) await workspaces.assign(args[1], ["auto", "unassigned"].includes(args[2]) ? null : args[2], args[2] === "auto");
            else if (args.length > 0) throw new Error("Use workspaces [save <json>|remove <id>|assign <thread-id> <workspace-id|unassigned|auto>]");
            return { exitCode: 0, stdout: JSON.stringify(await workspaces.read()) };
          }
          case "snooze": {
            const threadId = resolveThread(args[0]);
            const when = args.slice(1).join(" ");
            if (threadId === undefined || when === "") break;
            const record = await snooze(threadId, when, note);
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(record)
                : `Snoozed ${threadId} until ${formatWhen(record.until)}.`,
            };
          }
          case "unsnooze": {
            const threadId = resolveThread(args[0]);
            if (threadId === undefined) break;
            return (await unsnooze(threadId))
              ? { exitCode: 0, stdout: `Woke ${threadId}.` }
              : { exitCode: 1, stderr: `${threadId} is not snoozed.` };
          }
          case "snoozed": {
            const snoozes = Object.entries(await getSnoozes()).sort(
              (a, b) => a[1].until - b[1].until,
            );
            if (json) return { exitCode: 0, stdout: JSON.stringify(Object.fromEntries(snoozes)) };
            const lines = await Promise.all(
              snoozes.map(async ([threadId, record]) => {
                const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
                return `${formatWhen(record.until).padEnd(16)} ${threadId}  ${thread?.title ?? ""}${record.note ? `  — ${record.note}` : ""}`;
              }),
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "Nothing snoozed." : lines.join("\n") };
          }
          case "wait-ci": {
            const prFlag = args.indexOf("--pr");
            const forFlag = args.indexOf("--for");
            const repoFlag = args.indexOf("--repo");
            const positional = args.filter((arg, index) => {
              if (prFlag !== -1 && (index === prFlag || index === prFlag + 1)) return false;
              if (forFlag !== -1 && (index === forFlag || index === forFlag + 1)) return false;
              if (repoFlag !== -1 && (index === repoFlag || index === repoFlag + 1)) return false;
              return true;
            });
            const threadId = resolveThread(positional[0] ?? "--self");
            if (threadId === undefined) break;
            const watchFor = forFlag === -1 ? undefined : z.enum(["checks", "reviews", "both"]).parse(args[forFlag + 1]);
            const watches = await watchThreadCi(threadId, {
              pr: prFlag === -1 ? undefined : Number(args[prFlag + 1]),
              watchFor,
              repo: repoFlag === -1 ? undefined : args[repoFlag + 1],
            });
            return {
              exitCode: 0,
              stdout: `Watching ${watches.map((watch) => `${watch.repo}#${watch.pr}`).join(", ")} for ${watches[0]!.watchFor}; ${threadId} will be messaged.`,
            };
          }
          case "prs": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            await prTracker.scan(threadId);
            await prTracker.refresh();
            const prs = (await prTracker.byThread())[threadId] ?? [];
            if (json) return { exitCode: 0, stdout: JSON.stringify(prs) };
            const lines = prs.map(
              (pr) => `${pr.stackedOn !== null ? "  └ " : ""}${pr.repo}#${pr.number}  ${pr.attention.padEnd(17)} ${pr.title}`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No PRs linked." };
          }
          case "classify": {
            const snoozedSection = await findSnoozedSection();
            // Debug view: where each open thread lands in the triage sidebar, with
            // the tail of its last agent message to check the call against.
            const [threads, awaitingAll, byThread, watching, sections, promised, waitingOthers] = await Promise.all([
              bb.sdk.threads.list({ limit: 500 }),
              awaiting.all(),
              prTracker.byThread(),
              watchingByThread(),
              bb.sdk.threadSections.list(),
              awaiting.promised(),
              awaiting.waitingOthers(),
            ]);
            const sectionName = new Map(sections.map((section) => [section.id, section.name]));
            const rows = [];
            for (const thread of threads) {
              if (thread.archivedAt !== null || thread.visibility !== "visible" || thread.parentThreadId !== null) continue;
              const snoozed = snoozedSection !== null && thread.sectionId === snoozedSection;
              const busy = thread.status === "active" || thread.status === "starting";
              const prs = (byThread[thread.id] ?? []).map((pr) => `${pr.repo.split("/")[1]}#${pr.number}:${pr.attention}`);
              const open = (byThread[thread.id] ?? []).filter((pr) => pr.state === "open" || pr.state === "draft");
              const settled = (byThread[thread.id] ?? []).every((pr) => pr.state === "merged" || pr.state === "closed");
              const needs = !snoozed && needsAttention(thread, awaitingAll);
              const group = snoozed
                ? "snoozed"
                : needs
                ? "needs-me"
                : thread.pinnedAt
                  ? "pinned"
                  : busy
                    ? "running"
                    : promised[thread.id] !== undefined && !watching[thread.id] && Date.now() - thread.updatedAt > 3_600_000
                      ? "stalled"
                      : awaitingAll[thread.id] !== undefined
                      ? "your-move"
                      : thread.sectionId === null &&
                          (waitingOthers[thread.id] !== undefined ||
                            (open.length > 0 && open.every((pr) => pr.attention === "review_requested")))
                        ? "waiting"
                      : thread.sectionId === null && !watching[thread.id] && settled && Date.now() - thread.updatedAt > 2 * 3_600_000
                        ? "done"
                        : "lane";
              const output = await bb.sdk.threads.output({ threadId: thread.id }).catch(() => ({ output: null }));
              rows.push({
                id: thread.id,
                title: thread.title,
                status: thread.status,
                section: thread.sectionId === null ? "Unassigned" : sectionName.get(thread.sectionId) ?? thread.sectionId,
                group,
                awaiting: awaitingAll[thread.id] !== undefined,
                watching: watching[thread.id] ?? null,
                openPrs: open.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}:${pr.attention}`),
                prs: prs.length,
                idleHours: Math.round((Date.now() - thread.updatedAt) / 3_600_000),
                tail: (output.output ?? "").trim().slice(-1500),
              });
            }
            return { exitCode: 0, stdout: JSON.stringify(rows) };
          }
          case "leftovers": {
            if (argv.includes("--clean")) {
              const { removed, kept } = await leftovers.clean();
              return { exitCode: 0, stdout: `Removed ${removed.length}, kept ${kept.length}.\n${kept.map((path) => `  kept ${path}`).join("\n")}` };
            }
            const report = await leftovers.read(refresh);
            if (json) return { exitCode: 0, stdout: JSON.stringify(report) };
            const lines = report.items.map(
              (item) =>
                `${item.safe ? "safe" : "KEEP"}  ${item.repo.padEnd(28)} ${item.branch.padEnd(40)} ${item.pr ? `${item.pr} ${item.prState}` : "no PR"}${item.dirty ? ` · ${item.dirty} uncommitted` : ""}${item.nodeModules ? " · node_modules" : ""}`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No leftover worktrees." };
          }
          case "deck": {
            // --wait <version>: block (max 25s) until something changes, then answer.
            const waitIndex = argv.indexOf("--wait");
            if (waitIndex !== -1) await waitForDeckChange(Number(argv[waitIndex + 1]), 25_000);
            const version = deckVersion;
            return { exitCode: 0, stdout: JSON.stringify({ version, ...(await deckSnapshot()) }) };
          }
          case "pr-radar": {
            const { broken, ready } = await prRadar();
            if (argv.includes("--open")) {
              const focused = focus.focusedThreadId();
              const queue = [...broken, ...ready];
              const next = queue.find((item) => item.threadId !== focused) ?? queue[0];
              if (next === undefined) return { exitCode: 0, stdout: "No PR needs you." };
              await bb.sdk.threads.open({ threadId: next.threadId, file: null });
              return { exitCode: 0, stdout: `Opened ${next.threadId}  ${next.title} (${next.pr})` };
            }
            if (json) return { exitCode: 0, stdout: JSON.stringify({ broken, ready }) };
            const lines = [
              ...broken.map((item) => `fix    ${item.pr.padEnd(22)} ${item.title}`),
              ...ready.map((item) => `merge  ${item.pr.padEnd(22)} ${item.title}`),
            ];
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No PR needs you." };
          }
          case "pr-link": {
            const remove = args.includes("--remove");
            const rest = args.filter((arg) => arg !== "--remove");
            const url = rest[0];
            const threadId = resolveThread(rest[1] ?? "--self");
            const match = url ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) : null;
            if (!match || threadId === undefined) break;
            await prTracker.link(threadId, { repo: match[1]!, number: Number(match[2]) }, remove);
            return { exitCode: 0, stdout: `${remove ? "Unlinked" : "Linked"} ${match[1]}#${match[2]}.` };
          }
          case "watches": {
            const result = await watchers.status();
            if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
            const lines = [
              ...Object.entries(result.autoContinue).map(([id, entry]) => `continue    ${id}  at ${formatWhen(entry.resetsAt + 90_000)}`),
              ...Object.values(result.releaseWaiters).map((waiter) => `release     ${waiter.threadId}  (${waiter.projectName})`),
              ...Object.entries(result.pendingReleases).map(([key, release]) => `deploying   ${key}  ${release.title}`),
              ...Object.values(result.ciWatches).map((watch) => `ci          ${watch.threadId}  ${watch.repo}#${watch.pr} (${watch.watchFor})`),
            ];
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "Nothing watched." };
          }
          case "release-wait": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            await watchers.registerReleaseWaiter(await bb.sdk.threads.get({ threadId }));
            return { exitCode: 0, stdout: `${threadId} will be woken on the next release (if its project has releaseWatch configured).` };
          }
          case "check-now":
            await watchers.checkReleases();
            await watchers.checkCi();
            return { exitCode: 0, stdout: "Checked releases and CI watches." };
          case "your-move": {
            const { items } = await yourMove({ withAsk: !argv.includes("--open") });
            if (argv.includes("--open")) {
              // Oldest first; skip the one you're already looking at.
              const focused = focus.focusedThreadId();
              const next = items.find((item) => item.threadId !== focused) ?? items[0];
              if (next === undefined) return { exitCode: 0, stdout: "Nothing is waiting on you." };
              await bb.sdk.threads.open({ threadId: next.threadId, file: null });
              return { exitCode: 0, stdout: `Opened ${next.threadId}  ${next.title}` };
            }
            if (json) return { exitCode: 0, stdout: JSON.stringify({ count: items.length, items }) };
            const lines = items.map((item) => `${formatWhen(item.since).padEnd(16)} ${item.threadId}  ${item.title}`);
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "Nothing is waiting on you." };
          }
          case "focus-clients": {
            const rows = focus.clients().map((entry) => ({
              clientId: entry.clientId,
              threadId: entry.threadId,
              windowFocused: entry.windowFocused,
              interacted: entry.interactedAt ? formatWhen(entry.interactedAt) : "never",
              reported: formatWhen(entry.at),
              origin: entry.origin ?? "?",
              userAgent: entry.userAgent ?? "?",
            }));
            return { exitCode: 0, stdout: JSON.stringify(rows, null, 2) };
          }
          case "focused": {
            const threadId = focus.focusedThreadId();
            if (threadId === null) return { exitCode: 1, stderr: "No focused thread." };
            const thread = await bb.sdk.threads.get({ threadId });
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify({ threadId, projectId: thread.projectId, title: thread.title, status: thread.status })
                : `${threadId}  ${thread.title ?? ""}`,
            };
          }
          case "decisions": {
            const result = await decisionsFor(resolveThread(args[0] ?? "--focused") ?? null);
            const options = result.options;
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(result)
                : options.map((option) => `${option.n}. ${option.text}${option.recommended ? " (recommended)" : ""}`).join("\n") ||
                  "No open decision.",
            };
          }
          case "stop": {
            const threadId = resolveThread(args[0] ?? "--focused");
            if (threadId === undefined) return { exitCode: 1, stderr: "No focused thread." };
            await bb.sdk.threads.stop({ threadId });
            return { exitCode: 0, stdout: `Stopped ${threadId}.` };
          }
          case "tell": {
            const flag = args.indexOf("--thread");
            const target = flag === -1 ? await focus.requireFocused() : args[flag + 1];
            const text = (flag === -1 ? args : args.slice(0, flag)).join(" ").trim();
            if (target === undefined || text === "") break;
            await bb.sdk.threads.send({
              threadId: target,
              mode: "queue-if-active",
              input: [{ type: "text", text, mentions: [] }],
            });
            return { exitCode: 0, stdout: `Sent to ${target}.` };
          }
          case "needs-me": {
            const threads = await focus.needsMe();
            if (json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  count: threads.length,
                  threads: threads.map((thread) => ({ id: thread.id, title: thread.title, status: thread.status })),
                }),
              };
            }
            return {
              exitCode: 0,
              stdout: threads.length === 0 ? "Nothing needs you." : threads.map((thread) => `${thread.id}  ${thread.title ?? ""}`).join("\n"),
            };
          }
          case "next": {
            const focused = focus.focusedThreadId();
            const next = (await focus.needsMe()).find((thread) => thread.id !== focused);
            if (next === undefined) return { exitCode: 0, stdout: "Nothing needs you." };
            await bb.sdk.threads.open({ threadId: next.id, file: null });
            return { exitCode: 0, stdout: `Opened ${next.id}  ${next.title ?? ""}` };
          }
          case "repo": {
            const threadId = resolveThread(args[0] ?? "--self");
            if (threadId === undefined) break;
            const result = await repo.status(threadId);
            if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
            const runLabel = (id: string) => {
              const run = result.runs.find((candidate) => candidate.commandId === id);
              return run ? `  [${run.status}${run.url ? ` ${run.url}` : ""}]` : "";
            };
            const pinned = result.commands.map((command) => `${command.id.padEnd(16)} ${command.label}${runLabel(command.id)}`);
            const scripts = result.scripts.map((script) => `${script.id.padEnd(16)} ${script.command}${runLabel(script.id)}`);
            const out = [result.projectName];
            if (pinned.length) out.push("", "Pinned:", ...pinned);
            if (scripts.length) out.push("", "Scripts:", ...scripts);
            else if (result.scriptsError) out.push("", `Scripts: ${result.scriptsError}`);
            if (!pinned.length && !scripts.length && !result.scriptsError) out.push("No commands or scripts.");
            return { exitCode: 0, stdout: out.join("\n") };
          }
          case "repo-run":
          case "repo-stop": {
            const threadId = resolveThread(args[1] ?? "--self");
            if (args[0] === undefined || threadId === undefined) break;
            if (command === "repo-stop") {
              return (await repo.stop(threadId, args[0]))
                ? { exitCode: 0, stdout: `Stopped ${args[0]}.` }
                : { exitCode: 1, stderr: `${args[0]} is not running in ${threadId}.` };
            }
            const run = await repo.run(threadId, args[0]);
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(run) : `Started ${run.label} (terminal ${run.terminalId})${run.url ? `; browser opens at ${run.url} once the port is up` : ""}.`,
            };
          }
          case "repo-config": {
            const [projectNameArg, ...rest] = args;
            const value = rest.join(" ");
            if (projectNameArg === undefined || value === "") break;
            const commands = value === "reset" ? null : z.array(repoCommandSchema).parse(JSON.parse(value));
            await repo.setCommands(projectNameArg, commands);
            return { exitCode: 0, stdout: commands === null ? "Reset." : `Saved ${commands.length} command(s).` };
          }
          case "wake-now":
            return { exitCode: 0, stdout: `Woke ${await wakeDue()} thread(s).` };
          case "digest": {
            const digest = await readDigest(refresh);
            if (json) return { exitCode: 0, stdout: JSON.stringify(digest) };
            const lines = digest.items
              .slice(0, 100)
              .map((item) => `${String(item.idleDays).padStart(3)}d  ${item.threadId}  ${item.title}`);
            const more =
              digest.items.length > 100 ? `\n… and ${digest.items.length - 100} more` : "";
            return {
              exitCode: 0,
              stdout: `${digest.items.length} stale thread(s), generated ${new Date(digest.generatedAt).toLocaleString()}\n${lines.join("\n")}${more}`,
            };
          }
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
        }
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.log.info("loaded");
}
