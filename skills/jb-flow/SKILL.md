---
name: jb-flow
description: Organise BB projects, threads, sections and tools into workspaces; catch up on unread threads one card at a time; snooze BB threads until a date (with an optional wake-up prompt) and review the stale-thread digest with the `bb jb-flow` command or the snooze_thread tool.
---

# jb-flow

## Workspaces

Requires BB Plugin SDK 0.6.54 or later. The workspace navigation provider can be
selected under Settings → Appearance → Sidebar navigation. Workspaces group
projects, sections and tool navigation; they do not isolate credentials,
permissions or background plugin execution.

- `bb jb-flow workspaces`: JSON configuration and explicit thread assignments.
- `bb jb-flow workspaces assign <thread-id> <workspace-id|unassigned|auto>`.
- `bb jb-flow workspaces save '<json>'`: `{ id, name, projectIds, sectionIds, pluginIds, sectionOrder }`. Use `id: null` to create and an existing ID to edit. Selecting a project or section transfers its grouping to this workspace. Tools may be shared between workspaces; tools assigned nowhere appear everywhere.
- `bb jb-flow workspaces remove <workspace-id>`: remove grouping only, keeping threads, projects and sections; explicit assignments become unassigned.

Thread membership: explicit override, inherited parent, section, project, then
No workspace (id `unassigned`). All shows every workspace. A new install has no
workspaces until the user creates them (Create your first workspace in the bar). The active tab and last thread are local to
the browser session; configuration and assignments are server-persisted.

RPC equivalents are `workspaces_get(null)`, `workspace_save(workspace)`,
`workspace_remove({ id })`, and
`workspace_assign({ threadId, workspaceId, automatic })`. `automatic: true`
removes an override; `workspaceId: null, automatic: false` forces No workspace.

## Child threads in Triage

JB Flow's Triage sidebar nests children below their parent, including children in
other worktrees or sections. The arrow expands or collapses a branch; a badge
counts descendants and shows running, needs-attention and unread activity. The
active thread's ancestors open automatically. On a focused row, `→` opens the
branch or focuses its first child; `←` closes it or focuses its parent.

Smart, machine and tag filters include matching children and retain ancestors
for context. Snoozed children stay in Snoozed. If a parent is hidden, archived or
outside the selected workspace, visible children appear as top-level rows.
Sidebar placement does not change stored parent links, sections or workspaces.
Choose JB Flow's Triage provider under Settings → Appearance → Thread list.

## Palette (⌘K)

A UI feature, with no CLI. While the **⌘K opens the JB Flow palette** setting is on (it
is by default), BB's Search threads key opens JB Flow's palette. That key is ⌘K unless
it was rebound. In the palette:
- Typing searches threads, messages, PRs, workspaces, projects and actions.
- `>` narrows to actions, `#` to PRs, `@` to workspaces and projects, and `/` to files in the open thread's checkout.
- `is:needs`, `is:running`, `is:snoozed`, `is:unread`, `is:pinned` and `is:pr` filter threads.
- Tab on a thread lists its actions, including snooze, reply and move.

When a user asks how to search messages or act on threads quickly, point them here.
BB's own search stays in the quick palette under *Search threads…*.

## Catch up

A UI feature, with no CLI, on while the **Catch up** setting is (the default). It goes
through unread threads one card at a time: the **Catch up** page in the navigation,
⌥⇧C (*Catch up on unread threads*), ⌘K → *Catch up on unread threads*, or the line
above *Your move* on the home page. Threads that need the user come first. Each card
shows what happened since the user last read the thread, then the thread itself with
its composer, so they can read and answer in place. `→` marks read, `←` keeps it
unread, `r` writes in the thread, and `s`, `e`, `o` and `z` snooze, archive, open and
undo.

When a user asks "what did I miss?" or wants to clear unread threads, point them here.
Hand-backs that end with a status report (Goal/Done/Next/Blocked plus Next steps) read
well in Catch up: the latest reply is at the bottom of the card's thread, and its next
steps show under *Your next move* in the composer.

## Snooze

Snoozing moves a thread into the hidden "😴 Snoozed" section. Once a minute a
schedule checks for due snoozes. A due thread goes back to the section it came
from and is marked unread. If a note was given, the note is sent to the thread
as a prompt ("⏰ Snooze reminder: …").

- From inside a thread, prefer the `snooze_thread` agent tool: `{ when, note? }`.
- CLI:
  - `bb jb-flow snooze <thread-id|--self> <when> [--note <text>]`
  - `bb jb-flow unsnooze <thread-id|--self>`
  - `bb jb-flow snoozed [--json]`
  - `bb jb-flow wake-now`: runs the due check immediately

`<when>` accepts `30m`, `2h`, `3d`, `1w`, `today` (17:00), `tonight` (20:00),
`tomorrow` (08:00), `mon`…`sun` (next one, 08:00), `next-week`, `YYYY-MM-DD`
(08:00), and `YYYY-MM-DDTHH:MM`. All times are server-local.

Write the note as an instruction to the agent that will wake up, for example:
"Check whether Martin replied in Slack #billing; if so, summarize and propose
next steps."

If a snoozed thread is moved out of the Snoozed section by hand, or is
archived, its snooze is cancelled.

## Stale-thread digest

`bb jb-flow digest [--refresh] [--json]` lists threads that match all of these:

- unsectioned
- unpinned
- not running
- not snoozed
- idle longer than the `staleDays` setting (default 7)

The digest is rebuilt at 08:00 on weekdays and is shown on the BB homepage,
where the user can archive, keep for 14 days, or snooze threads. Never archive
digest threads unless the user asks you to.

## Repo commands (dev servers)

Each project can have repo commands. Running one opens a BB terminal tab in
the thread's side panel. If the command has a URL, a BB browser tab opens too,
as soon as the port accepts connections (the check gives up after 5 minutes).
A command can have several slots, and the first slot whose ports are all free
is used. For example `pnpm dev`, then `pnpm dev:2`, then `pnpm dev:3`, each on
its own ports, so parallel worktrees don't clash.

- `bb jb-flow repo [--self|<thread-id>]`: list pinned commands, root package.json scripts, and runs
- Scripts run as `script:<name>`, e.g. `bb jb-flow repo-run script:lint --self`
- `bb jb-flow repo-run <command-id> [--self|<thread-id>]`, e.g. `bb jb-flow repo-run dev --self`
- `bb jb-flow repo-stop <command-id> [--self|<thread-id>]`
- `bb jb-flow repo-config <project-name> '<json>'|reset`

When the user asks you to start the dev servers, run `repo --self` to see the
project's commands, then `repo-run <id> --self` (usually `dev`, or a
`script:<name>` such as `script:dev`). Don't start the dev server in your own
shell: that leaves the user without the terminal and browser tabs.

## Waiting on CI, reviews and releases (don't poll)

Never poll GitHub in loops. That means no `gh pr checks --watch`, no `gh run watch`, no `until gh …; sleep`, and no repeated `gh pr view`. Polling burns tokens and session limits.

- **CI and reviews:** after pushing or opening a PR, call the `wait_for_ci` tool and end your turn. The CLI equivalent is `bb jb-flow wait-ci --self [--pr <n>] [--for checks|reviews|both]`. You get a message when:
  - the checks finish (failed logs included),
  - a review or comment arrives, or
  - the PR merges or closes.

  The message only comes once your thread is idle. While you keep working, nothing arrives, so use `pr_status` to check a PR yourself.
- **Releases:** when you're blocked on a release, say so plainly ("waiting for release") and end your turn.
  - In projects with `releaseWatch` configured, the thread is woken with "released: …" once a release PR merges and its workflows pass.
  - To register explicitly: `bb jb-flow release-wait --self`.
- **Usage limits:** if a session or weekly limit stops you, "continue" is scheduled automatically for just after the reset.

`bb jb-flow watches` lists everything currently being watched.

## Threads with several PRs (stacked or across repos)

Every PR a thread opens with `gh pr create` is linked to it automatically, in any repo. Stacks are detected from base and head branches.

- `bb jb-flow prs --self [--json]`: the thread's PRs, in stack order, with each one's state (checks, review, conflicts, merged).
- `bb jb-flow pr-link <url> --self [--remove]`: link or unlink a PR that was opened another way, for example through a GitHub MCP tool or by someone else.
- `pr_status` (agent tool) returns the state of all of them in one call, from the plugin's cache, or live with `refresh: true`. Use it instead of `gh pr view` / `gh pr checks` for state; use `gh` only for full review comments or logs.
- **One Actions run:** to wait for a run that is not a PR check, such as a deploy after a merge or a release job, call `wait_for_run` with its id or URL and end your turn (CLI: `bb jb-flow wait-run <run-id|url> --self`). You get one message when it finishes, with the failed jobs and log on failure. The thread shows as waiting meanwhile. Do not watch runs with `gh run watch`, sleep loops or background shell jobs.
- `wait_for_ci` with no `pr` watches every open PR this thread created. Pass `repo` (owner/name) for a PR in another repo that this thread didn't create. News from all of a thread's PRs arrives as one message per check cycle.

## Decision buttons

When your message ends with a numbered list of options (one line each), the user sees them as one-click reply buttons above the composer, and an option marked "(recommended)" is highlighted. The reply is just the number.

When the list is steps for you to run and ends with "Reply **go** for all, or **go 1,3**", the user ticks steps and presses Go instead. The reply is `go` for all of them, or `go` followed by the picked numbers.
