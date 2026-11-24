// The "Stop this thread's agent" command (⌘⇧⌫ by default): the keyboard twin of
// bb's stop button and the row menu's "Stop run". Pure, so the command's rules
// are tested without bb; app.tsx wires in the running threads and the stop call.
import type { Shortcut } from "./palette-model";

export const STOP_AGENT_COMMAND_ID = "stop-agent";
/** ⌘⇧⌫ on macOS, Ctrl+Shift+Backspace elsewhere. Nothing in bb or JB Flow uses it. */
export const STOP_AGENT_SHORTCUT: Shortcut = { key: "Backspace", mod: true, shift: true };

/** A thread whose agent has a turn under way: the states bb's stop button stops. */
export function isRunningStatus(status: string | null | undefined): boolean {
  return status === "active" || status === "starting";
}

export function runningThreadIds(threads: readonly { id: string; status: string }[]): ReadonlySet<string> {
  return new Set(threads.filter((thread) => isRunningStatus(thread.status)).map((thread) => thread.id));
}

type CommandContext = { threadId: string | null };

/**
 * The command registration. It acts only on the thread in view (`threadId` from bb's
 * command context), and only while that thread is running, so the key is inert elsewhere.
 */
export function stopAgentCommand(deps: {
  isRunning(threadId: string): boolean;
  stop(threadId: string): Promise<unknown>;
}) {
  const target = ({ threadId }: CommandContext) => (threadId !== null && deps.isRunning(threadId) ? threadId : null);
  return {
    id: STOP_AGENT_COMMAND_ID,
    title: "Stop this thread's agent",
    defaultShortcut: STOP_AGENT_SHORTCUT,
    isAvailable: (context: CommandContext) => target(context) !== null,
    run: async (context: CommandContext) => {
      const threadId = target(context);
      if (threadId !== null) await deps.stop(threadId);
    },
  };
}
