# bb-plugin-jb-flow

A [bb](https://getbb.app) plugin for people who run a lot of agent threads at once. It adds a Triage sidebar that puts threads waiting on you at the top, snooze, a stale-thread digest, PR and CI tracking that wakes threads instead of having agents poll, and dev-server buttons in the side panel.

## Requirements

- bb 0.46 or later **with Plugin SDK 0.6.54 or later**. Workspace navigation uses APIs newer than the SDK bundled with early 0.46.1 builds; update BB before installing this version.
- The [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`, for everything PR-related: PR tracking, `wait_for_ci`, `pr_status`, the release watcher and the Unreleased section. Repos must be on github.com. Snooze, the digest and the Triage list work without it.
- Auto-continue after usage limits recognises Claude Code's limit message only. Everything else works with any provider.

## Features

### Workspaces

On by default (turn off under Settings → JB Flow → **Workspaces**). Choose **JB Flow workspaces** under Settings → Appearance → Sidebar navigation
if another navigation provider is pinned. A new install has no workspaces yet: the bar shows **Create your first workspace**, which
opens a form to name it and pick its projects. After that your workspaces, plus **All** and
**No workspace**, appear as tabs (**+** adds another, the gear manages them) across the top of the BB window and filter its threads, sections,
Studio and home-page follow-ups. Tab badges show the total number of top-level threads; a small dot marks attention.
Hover a tab for both counts. Switching restores
the last thread for that workspace in this browser tab; a new-thread button
uses its first available project. Opening a thread from another workspace
reveals its workspace automatically. Switching does not stop agents.

A new install starts with no workspaces of its own. Use the **Manage workspaces** settings icon beside the tabs
or Settings → JB Flow → Workspaces to create or rename workspaces, choose
projects, assign sections and select tools. Selecting a project or section
moves that grouping from its previous workspace. Tools may belong to several
workspaces; unassigned tools remain shared. **More tools** always reaches the
other tools without changing their global visibility settings. This controls
navigation visibility, not plugin execution, credentials or permissions.

A thread uses an explicit workspace assignment first, then inherits its
parent's assignment, then its section or project. Use **Move to workspace** in
the sidebar context menu or BB's thread menu to override this, choose
**No workspace**, or restore **Automatic**. Removing a workspace keeps its
threads, projects and native sections. Explicit assignments to the removed
workspace move to No workspace. Section order is saved per workspace; workflow
lanes remain available with that workspace's threads. Workspace configuration
and thread assignments sync between clients. The active tab and remembered
threads belong to this browser session.

On macOS the tabs sit beside the native window and navigation controls, with
the thread title and header in a separate row directly below. Browser and mobile
clients reserve a row above the sidebar and conversation. The bar remains available when the sidebar is closed;
its shell spacing is removed when the plugin unloads. The settings icon opens
a focused dialog with searchable Projects, Sections and Tools lists. Workspace
settings are also available in plugin settings.

The same operations are available over RPC (`workspaces_get`, `workspace_save`,
`workspace_remove`, `workspace_assign`) and CLI:

```sh
bb jb-flow workspaces
bb jb-flow workspaces assign <thread-id> <workspace-id>
bb jb-flow workspaces assign <thread-id> auto
bb jb-flow workspaces assign <thread-id> unassigned
bb jb-flow workspaces save '{"id":null,"name":"Personal","projectIds":[],"sectionIds":[],"pluginIds":[],"sectionOrder":[]}'
bb jb-flow workspaces remove <workspace-id>
```

`save` returns the saved workspace, including its generated ID. Pass an existing
ID to edit it; names must be unique. These commands return JSON.

### Command palette (⌘K)

On by default (turn off under Settings → JB Flow → **⌘K opens the JB Flow palette**).
The key BB uses for Search threads (⌘K, or Ctrl+K on Windows and Linux, unless you
rebound it under Settings → Keyboard) opens JB Flow's palette instead. Press the key
again or Escape to close it.

- **An empty query shows your triage.** Sections: *Needs you* (oldest first),
  *Running*, *PRs to act on* (failing checks, changes requested, conflicts, ready to
  merge), *Recent* (the threads you visited) and *This thread*.
- **Typing searches everything at once.**
  - Threads match on their title, project, branch, PR numbers and titles, tags,
    workspace and section. Threads in your current workspace, the ones you pick often
    and the ones waiting on you rank first.
  - BB's full-text search adds message matches, with snippets, and archived threads.
  - Pull requests, workspaces, projects and actions are ranked into the same list.
  - The last row always starts a new thread with what you typed. Press Tab on it to
    pick the project.
- **Narrow the scope.**
  - Prefixes: `>` for actions, `#` for pull requests (`#123` finds that PR), `@` for
    workspaces and projects, `/` for files in the open thread's checkout (Enter
    opens one in the thread's panel, like `bb thread open <path>`; ⌘Enter opens it
    in your editor). Backspace on an empty query
    clears the scope.
  - A group with more matches than fit ends in *Show all N …*. For threads, messages
    and archived matches, that opens *Threads & messages*: every match, up to 50 per
    group from BB's full-text search.
  - Filters: `is:needs`, `is:running`, `is:autopilot`, `is:ready` (the sidebar's four
    states), `is:snoozed`, `is:unread`, `is:pinned` and `is:pr` narrow threads, with or
    without text.
- **Act without opening.**
  - Enter opens the selected item. ⌘Enter opens a thread in a split, or a PR's thread.
  - Tab (or →) lists everything you can do to the selected thread, ready to filter:
    - reply to a numbered decision
    - snooze (type `tomorrow` or `3d` for "Snooze until …")
    - move to a lane, section or workspace
    - add (`tag urgent`) or remove tags
    - open its PRs or watch their CI
    - stop a run
    - copy its ID
    - BB's own and other plugins' thread actions (archive, pin, rename, copy link, …)
  - Escape, Shift+Tab or ← goes back.

Rows show the same status icon as the Triage list, plus project, workspace, PR state,
tags, snooze and branch. On wide windows a pane beside the results previews the
selected thread: its goal, next step or blocker, PRs and details, as in the Triage
hover card. When the selection isn't a thread, the pane shows the scopes and keys.

Close the palette without running anything and reopen it within 30 seconds: your
query and scope come back, selected, so typing replaces them. Running something
clears them. The command *Open JB Flow palette* (in BB's quick palette, rebindable
under Settings → Keyboard) opens the palette even with the setting off.

The setting is off, or the plugin is disabled? Then the key is BB's Search threads
again. BB's own search also stays reachable through the quick palette → *Search
threads…*. A message match opens its thread, but it can't scroll to the message yet,
because the plugin SDK has no way to do that. Recent picks and visits are stored in
this browser only.

### Catch up

On by default (turn off under Settings → JB Flow → **Catch up**). Goes through your
unread threads one card at a time, each with the thread itself, so you can read and
answer them without opening each one.
Open it from the **Catch up** page in the navigation (its badge counts unread threads
in the current workspace), with ⌥⇧C (*Catch up on unread threads*, rebindable under
Settings → Keyboard), from ⌘K, or from the *Catch up · N unread* line on the home page.

- **What's in it.** Unread top-level threads (and forks) in the current workspace tab;
  the chip in the header switches to all workspaces. Snoozed, archived and hidden
  threads stay out, and so do threads still working, unless they're waiting on you.
  They join when they finish.
- **Order.** Threads that need you come first: a prompt or permission, a failure,
  then an agent that handed the next step to you. Then PRs to act on, then other
  updates, each group oldest first. The order is fixed when you start, so cards never
  move under you. New arrivals wait behind an *N new* pill (or `n`).
- **Each card** starts with a short summary: the thread's status, project and age,
  what happened since you last read it (turns, prompts from you, automated prompts
  such as CI results and snooze reminders, PRs merged since) and its open PRs, with
  merged and closed ones folded away. Below it is the thread itself, live, with its
  composer: read the conversation, answer a prompt or permission, pick from *Your
  next move*, or write a reply, as in the thread view. Showing a card doesn't mark
  the thread read; writing in its composer does, as anywhere in bb.
- **Keys:**

  | Key | Action |
  | --- | --- |
  | `→` or `d` | Done: mark read and go on |
  | `←` or `u` | Keep unread and go on |
  | `r` | Write in the thread's composer (Esc comes back to these keys) |
  | `s` | Snooze (`1`–`5` for a preset, or type `3d`, `fri`) |
  | `e` | Archive |
  | `o` or Enter | Open the thread (`⇧O` or ⌘Enter opens it in a split) |
  | `z` or ⌘Z | Undo |
  | `?` | List the keys |

  Snooze also marks the thread read. Keep unread puts back a thread you wrote in.
- **Touch.** Swipe a card's summary right for Done and left to keep it unread; a long
  press opens Snooze. On small screens the overlay is a bottom sheet.
- **Undo** reverses the last actions in order: read, snooze and Mark all read are
  reverted, and an archive waits 8 seconds before it happens (bb removes an archived
  thread's worktree), so undoing it in time changes nothing. A sent message can't be
  undone.
- **Mark all read** clears the remaining updates and PR cards in one step; threads
  that need you stay in the deck.
- **The end** shows what you did, offers the threads you kept unread again, and picks
  up new arrivals. Reopen within 15 minutes and the deck carries on where you left off.

With the setting off, the command, palette entry, home-page line and badge are gone and
the page says it's off. bb's own navigation rail still lists the page, because a
plugin page can't hide itself yet; JB Flow's workspace navigation hides it.

### App-wide appearance

**Polish the entire BB interface** (Settings → JB Flow, on by default) applies
across the standard BB interface: inset sidebar selections, refined section
headings and rail controls, layered page surfaces, elevated composers, panel tabs,
menus, dialogs, and the command palette. It works with any palette; Graphite adds
coordinated sidebar, card, popover, and recessed colors in light and dark mode.

Turn the setting off to restore standard shell styling while keeping Studio and
the palette. The content script removes its root class and event listeners on
reload or disable. Reduced motion and forced colors are respected. BB continues
to own navigation, panel resizing, conversations, touch targets, and scrolling.
This setting changes shell styling; Workspaces separately uses BB's navigation
and app-overlay APIs to arrange its tabs and tools. Shell selectors use the current host's DOM attributes and
need visual rechecking after BB upgrades.

### Live agent activity

The composer combines the current action, a two-line goal summary, usage, and
linked PR status in one compact activity panel. Visible meters distinguish plan
and workflow step completion from goal token-budget consumption and context
usage (marked estimated when the host reports an estimate). Active work without
known totals uses an indeterminate activity bar. Percentages are never presented
as goal completion. An animated live indicator and local elapsed clock keep work
visible; quiet, waiting, stopping, and disconnected states have distinct labels.

**Details** contains the full goal and its Clear goal control, current command,
task models/usage, workflow progress, recent tool activity, and the plan. Read-only
PR and goal/to-do summaries are consolidated only when their replacement data and
controls are available; native Git, parent-thread and PR merge controls remain.
PR links preserve BB's navigation preference and reject unsupported URL schemes.

The card uses a bounded public timeline snapshot, refreshed by thread realtime
events (bursts coalesce over 750ms), and resyncs after reconnecting. Its one-second
clock updates locally. No network polling or estimated completion percentage is
used. The native background/workflow callouts are hidden only in the same
composer after a successful card render; they return if the request fails or
shell styling is switched off. Git summary controls stay native, with larger
styling. Reduced-motion preferences disable decorative animation.

### Persistent thread monitor

On by default (**Thread monitor** in the plugin settings). The activity card stays visible when the agent is idle,
as a quiet summary of the agent's last status report: **Done**, **Next**, **Goal** and **Blocked**, with milestone
bars and context use under **Details**. When the report is out of date (the agent replied since, it's over 6 hours
old, or there is none), the header says so and offers **Update status**; otherwise a small **Refresh** does the same.

If the report ends with numbered **Next steps** (the built-in prompt asks for a recommended path forward in a callout),
they appear in **Your next move** above the monitor (see Decision buttons), and a **Doing now** line shows what the
agent is already doing. **Auto-prompt** in its footer (with a count, or "off") opens a menu of everything that will message the thread on
its own: continuing after a usage limit resets, and each CI/review watch and release wait (see Watchers). Untick one
to stop it.

**Update status** sends the **Status report prompt** setting to this thread (empty uses a short
built-in prompt in that format), preserving your composer draft. It runs only when clicked.
In a thread with child threads, the request also lists every child (and their children) with its state and
last report, and asks for one report on the whole job: progress per child, a **Children** section, and next
steps that steer them. The agent messages a child only after you reply go.
To skip the button, turn on **Status report at hand-back**: agents then end every reply that hands the
thread back to you (done, blocked, or waiting for your input) with that report, and the monitor keeps itself
current. Threads pick it up when their session next starts.
The monitor refreshes on thread
events and reconnects. Running agents retain the live command/workflow view;
idle headers reflect pending input, errors and JB Flow watches. Milestone bars
show the values reported by the agent, separately from measured plan, workflow,
context and token-budget meters. No overall completion percentage is inferred.
Saved information remains visible during refresh failures; native activity
controls return if the live timeline is unavailable.

### Compact live tool trace

With **Polish the entire BB interface** on, active native command bundles keep running work prominent in a bordered activity
card with an indeterminate sweep. Earlier completed commands and thinking steps
fold behind **Show trace**, with a live step count. Errors and explicitly opened
output stay visible. Native approvals and questions remain outside these bundles.
The enhancement preserves native nodes, controls and output; it restores the
original view when work finishes, the shell setting is disabled, or the plugin
unloads. Unrecognized markup stays native. Reduced motion disables the sweep.

### Reply choices

Numbered decisions appear as one compact list with a row per option: a number
badge, up to two lines of text, and a Recommended label on the right. A long
list scrolls inside a capped box instead of pushing the composer. Choosing
one sends only its number, with visible sending/sent feedback. Duplicate clicks
are blocked; failed sends show an error and allow retry. Choices reset when the
thread or source reply changes. Motion respects reduced-motion preferences.

### Studio

Open **Studio** in the navigation rail for an attention-first overview and a
thread workspace. Filter by project, working/needs-you/ready status, or title;
press `/` inside Studio to focus search. Switch between comfortable and compact
rows, and load more threads as needed.

Opening a row keeps the conversation inside Studio using BB's native chat,
including streaming, drafts, permissions, and pending interactions. **Review**
opens the host's resizable side panel with linked PRs and checks; **Open thread**
opens the regular thread page for the full thread-specific tools. Deep links and
browser back/forward work between the overview and thread workspaces.

Status counts apply to the selected project, independently of title search.
Needs-you includes pending input, failed threads, requests for a decision (read or not),
and linked PRs with failed checks, conflicts, or requested changes. Ready-to-merge
and PR-settled states use the PRs tracked by JB Flow; idle threads are not assumed
complete. Hidden and archived threads are excluded. The review panel additionally
includes BB's branch PR lookup. Workflow state resyncs after reconnecting.

**Graphite**, under **Settings → Appearance**, is an optional app-wide palette:
charcoal in dark mode, warm ivory in light mode, and a soft violet accent. Studio
also follows other BB palettes. Its responsive layout, keyboard focus, and reduced
motion styles are scoped to the Studio page.

The Studio branch is an initial working prototype. Its SDK integration is covered
by `npm run test:ui`; classification and filtering run with the existing unit
tests in `npm test`.

### Triage sidebar
A replacement thread list. **Installing JB Flow switches your sidebar to it**: bb uses the first installed thread-list plugin while **Settings → Appearance → Thread list** is on *Automatic*. Switch back there at any time. The list offers to create its lane sections the first time (or use **Settings → JB Flow → Triage lanes**).

- **States.** Every thread that isn't snoozed is in exactly one of four states, first match wins. The filter chips above the list show each state's count; click one to see only those threads, still in their sections. Hover a row for its state and why ("red PR web-app#7 (checks failed), nothing watching"); `bb jb-flow states` lists them all.
  1. **Running**: an agent is working on it now (a red PR is noted).
  2. **Needs me**: it can't continue without you. A prompt or permission request, a failed turn, a last message that asks you an actual question (a sentence ending in "?", or answer buttons, a form or a decision board; a menu of next steps like "Reply go for all" is not a question), an open PR with failing checks, requested changes or conflicts that nothing is watching, or an agent that said it would report back but has been idle for over an hour with nothing watching it.
  3. **Autopilot**: it continues without you. JB Flow watches its CI, a run, a release or a usage-limit reset; the agent will report back (within the hour); or it waits on someone else, including PRs that only wait for a reviewer.
  4. **Ready**: nothing left for the agent. A green PR to ship (listed first), or finished. **Archive all** archives the finished ones that are unfiled, idle for 2+ hours and whose PRs are all merged or closed; the thread you have open is never included.
  Bold is the only read signal, so unread status updates stay in their section, in bold.
- **Groups**, top to bottom:
  - **Lanes**: Priority, Active, Waiting for others, Pick up later, Low priority. Each is matched to one of your sections by name the first time, then remembered by id, so you can rename a lane's section (right-click → Rename…) and it keeps its number key and behaviour. Active is the unsectioned bucket and can't be renamed.
  - **Waiting for others** fills itself (marked *auto*): unfiled threads whose agent says it's waiting on someone else ("Alex is the only pending reviewer", "once he sends the invoices", "tell me when he replies"), or whose open PRs all wait on a reviewer. Threads you file there yourself go back to Active by themselves when a turn ends without waiting on anyone. Snoozed threads that were waiting on someone ("when it wakes, I'll check for Sam's reply") wake into Waiting for others instead of their old section.
  - Any other sections, collapsed.
  - Snoozed threads, collapsed.
- **Machines**: once threads run on more than one machine, each machine gets a filter chip with its thread count (e.g. *Mac Studio 48*, *MacBook Air 2*); click one to see that machine's threads across all sections. Rows on a machine other than the one BB runs on carry a short tag (*Air*, *MBP*), and the hover preview always names the machine.
- **Rows** show a project chip with a stable colour per project, tags, and an age fade for idle threads.
- **Child threads** sit below their parent, with indentation, connecting lines and a disclosure arrow. A parent's badge counts its descendants and shows running, needs-attention and unread activity even while collapsed. The selected thread's branch opens automatically; other branches remember your choice in this browser. Children keep their own navigation, status and row actions, including when they use a different worktree or section. Filters include matching children and show their ancestors for context. Snoozed children stay in Snoozed; a child whose parent is unavailable appears as a top-level row.
- **Keyboard**, on a focused row:
  - `1`–`5` move it to a lane
  - `s` snooze
  - `t` tag
  - `e` archive
  - `u` toggle unread
  - `j`/`k` move up and down
  - `→` expand a branch or focus its first child; `←` collapse it or focus its parent
- **Right-click menu:**
  - open / open in split view
  - pin, read/unread, rename
  - move to a section (or **Move to → New section…** to create one in the current workspace and file the thread there), snooze, tags
  - copy link or ID
  - archive, delete
- Drag a row into the main area to open it in a split, or onto another section to move it there.
- **Bare / Alle:** hover a section header to show only that section (including Unassigned); Pinned stays visible. **Vis alle** restores every section. The choice is saved in this browser; the section menu also lets you switch individual sections on or off.
- Drag a section header to reorder sections, or use Move up / Move down in its right-click menu. Lanes (Priority, Active, …) and your own sections share one order.
- **Section project:** right-click a section → *Project for new threads* to give it a project. *New thread here* (shown as *New thread in &lt;project&gt;*) then opens the composer with that project selected and files the thread in the section.
- **Tags** allow several per thread. A settings button converts "area" sections (e.g. Commercial) into tags.

### Snooze
- A clock button in the thread header, `bb jb-flow snooze <thread|--self> <when> [--note …]`, and a `snooze_thread` agent tool.
- A snoozed thread moves to a "😴 Snoozed" section, which the Triage list keeps collapsed at the bottom.
- When it's due, it goes back to its previous section and is marked unread. If a note was set, the note is sent as a prompt.
- `<when>` accepts `2h`, `3d`, `1w`, `tomorrow`, `mon`…`sun`, `next-week`, or `YYYY-MM-DD[THH:MM]`.
- Unsnoozing puts the thread back in the section it came from.

### Stale-thread digest
- A home page section listing unsectioned threads idle for more than N days (default 7), each with a one-line summary.
- Bulk actions: Archive, Keep 14 days, Snooze 1 week. Nothing is archived without a click.
- Rebuilt at 08:00 on weekdays. Run it from the CLI with `bb jb-flow digest`.

### Scripts and dev servers (side panel)
- **Scripts** (in the side panel's Actions) lists every script in the thread checkout's root `package.json`. The package manager is detected from the lockfile.
- Running a script opens a terminal tab. If the script contains a port, a browser tab opens once that port responds.
- **Pinned commands** per project can have fallback slots, e.g. `pnpm dev` → `pnpm dev:2` → `pnpm dev:3`. The first slot whose ports are free is used, so parallel worktrees don't collide.
- **Start dev servers** runs a project's pinned `dev` command in one click.

### Plan reviews
- On by default (**Expand plan reviews** in the plugin settings).
- Plans awaiting approval open expanded and use up to 75% of the window height instead of 288px.
- Drag the handle on top of a plan to make it taller or shorter; double-click it to reset. The height is remembered in this browser.
- This is a content script, so it depends on bb's plan-banner markup.

### Multi-PR threads (stacked and cross-repo)
- Every PR a thread opens with `gh pr create` is linked automatically, in any repo. You can also link PRs manually.
- One batched GitHub GraphQL query every 3 minutes keeps their state current: checks, review, conflicts, draft or merged.
- PRs whose base branch is another PR's head are shown as a stack. Trunk branches like `dev` and `main` are ignored for this.
- Rows show the PR that most needs attention plus a count. A **Pull requests** side-panel tab lists the stack, lets you link or unlink PRs, and starts a CI watch for all of them.
- Threads whose PRs are all merged or closed go into a **ready to archive** group, with **Archive all**. Threads waiting on a release or CI, or in Priority, are left out.

### Decisions and "Your move"
- **Decision buttons:** when an agent's last message ends with numbered options, they appear under **Your next move** above the composer and the thread monitor. The recommended one is highlighted. A decision sends the option's number in one click. A list of steps to run with go (a status report's **Next steps**, or a list ending "Reply go for all, or go 1,3") lets you tick steps, then **Go** sends `go`, or `go 1,3` with steps ticked.
- **Leftover worktrees:** bb removes a thread's worktree when it's archived, but extra checkouts an agent adds next to it (cross-repo work) and failed teardowns stay on disk. A weekly scan (Mondays 08:00) lists them under the stale digest with their PR state, uncommitted changes and node_modules, plus a button that deletes the merged, clean ones. Also `bb jb-flow leftovers`.
- **Your move:** a home-page section lists threads whose agent handed the next step to you, oldest first. With Catch up on, a *Catch up · N unread* line above it opens the deck. Threads waiting 3+ days are flagged, and each has Snooze 3d and Archive. Also `bb jb-flow your-move`.
- **Unreleased:** a home-page section (above Your move) lists the PRs merged into the selected project's default branch that haven't been released yet, newest first, with author, age and a compare link. If the repo has a `main` branch next to its default branch (`dev`), unreleased means on `dev` but not yet on `main`; otherwise it means merged since the latest release or `v*` tag. Cached for 5 minutes; Refresh reads GitHub again.
- **`pr_status` agent tool:** all of a thread's PRs in one call, so agents stop running `gh pr view` / `gh pr checks` loops.

### Thread status at a glance
- **Row icon:** needs input / failed / running / stuck / watched / PR state.
- **Running threads:** show elapsed time. After 15 minutes without output they're flagged "stuck", and you can stop them from the row menu or the header chip.
- **Hover preview:** hovering a row shows the last reply, the PR stack, what's being watched, and the run time.
- **Thread header strip:** shows run time or stuck, the watch, and the PR summary. Clicking the PR summary opens the PR panel.
- **Command palette:**

  | Shortcut | Command |
  |---|---|
  | Alt+Shift+S | Snooze this thread |
  | Alt+Shift+N | Open the next thread that needs me |
  | Alt+Shift+E | Archive and open the next one |
  | Alt+Shift+D | Start dev servers |
  | Alt+Shift+P | Show pull requests |
  | Alt+Shift+W | Watch CI |
  | Alt+Shift+U | Ask the agent for a fresh status report (the monitor's *Status*) |
  | Alt+Shift+I | Donkey: ask the agent to explain in plain words |
  | BB's Search threads key (⌘K) | Open the JB Flow palette (see above) |

### Watchers (no polling)
- **Auto-continue after usage limits** (switch per thread in the thread monitor; the setting *Continue after usage-limit resets* is the default for threads, off unless you change it): when Claude Code stops with "You've hit your session limit · resets 10pm", "continue" is scheduled for 90 seconds after the reset.
  - If you resume the thread yourself first, the scheduled message is cancelled.
  - Spend limits are left alone, since they need a human to raise them.
- **Release watcher:** threads that go idle "waiting for release" are woken with a "released: …" message.
  - This happens once a PR matching `titlePattern` merges into `base` and its workflow runs finish.
  - If the release workflow fails, the message names the failed runs instead.
  - Configure it per project with `releaseWatch` (see [Configuration](#configuration)).
- **CI and review watcher:** agents call the `wait_for_ci` tool (or `bb jb-flow wait-ci`) and end their turn, instead of polling `gh`.
- **Run watcher:** agents call `wait_for_run` with a GitHub Actions run id or URL (a deploy, a release job) and end their turn. The thread shows as waiting, and gets one message when the run finishes, with the failed log on failure.
  - The plugin polls once every 2 minutes for all watches.
  - It messages the thread when checks finish (with the failed log), when reviews or comments arrive, or when the PR merges.
  - A thread that is still working gets nothing. Once it goes idle, the next check sends one message with the current state of all its PRs.

### Focus tracking (for Stream Deck and scripts)
- Every BB window reports which thread is focused, including the focused pane in a split view.
- External controllers can then act on the focused thread without simulating keystrokes:
  - `bb jb-flow focused` prints the focused thread
  - `bb jb-flow decisions` lists the numbered options it's waiting on (the Stream Deck turns them into keys)
  - `bb jb-flow tell <text>` sends a message to it
  - `bb jb-flow stop` stops its run
  - `bb jb-flow needs-me` lists threads waiting on you
  - `bb jb-flow next` opens the next waiting thread
- `bb jb-flow deck` prints one JSON snapshot with all of the above, for a Stream Deck or a status bar script.

## Install

Install **JB Flow** from the bb plugin marketplace, or from source:

```sh
git clone https://github.com/Johannes-Berggren/bb-plugin-jb-flow
cd bb-plugin-jb-flow
npm install
bb plugin build
bb plugin install . --yes
```

After code changes: `bb plugin build && bb plugin reload jb-flow`.

## Settings

Under **Settings → JB Flow**:

- **Polish the entire BB interface**: restyles bb and folds finished commands behind *Show trace* (on by default).
- **Thread monitor**: the idle activity card with the last status report (on by default).
- **Workspaces**: workspace tabs across the top of bb (on by default).
- **⌘K opens the JB Flow palette**: the palette takes over BB's Search threads key (on by default).
- **Catch up**: the Catch up page, the ⌥⇧C command, its palette entry and home-page line (on by default).
- **Status report prompt**: what *Update status* sends; empty uses a short built-in prompt.
- **Status report at hand-back**: agents end replies that hand the thread back with the status report, so the monitor stays current (off by default).
- **Stale after (days)**: when an unsectioned thread shows up in the digest (default 7).
- **Continue after usage-limit resets**: whether threads auto-continue after a Claude Code usage limit unless switched in the monitor (off by default).
- **Expand plan reviews**: expanded, resizable plan reviews (on by default).
- **Advanced config (JSON)**: see below.
- **Triage lanes**, **Repo commands** and **Area tags** have their own sections.

## Configuration

Release watches and sidebar chip names are set in JSON in the **Advanced config** setting. A `local.config.json` in the plugin folder (gitignored; see `local.config.example.json`) still works, and is copied into the setting the first time the plugin loads with the setting empty, because a marketplace update replaces the plugin folder. The setting wins key by key. Reload the plugin after a change.

- `repoCommands`: pinned side-panel commands, keyed by bb project name. A command has `id`, `label`, and `slots[]`. Each slot has a `command`, a `url` (or `null`), and the `ports` it binds. These can also be edited per project under **Settings → JB Flow → Repo commands**, which overrides the JSON.
- `projectShortNames`: the label shown on a project's sidebar chip.
- `stripProjectPrefixes`: prefixes removed from project names on chips.
- `releaseWatch`: per project, either `{ "base": "main", "titlePattern": "^Release\\b" }` (a merged release PR counts, after its workflows finish) or `{ "mode": "release" }` (a published GitHub release counts). Both take an optional `"repo": "owner/name"`.

## CLI

```
bb jb-flow snooze <thread-id|--self> <when> [--note <text>]
bb jb-flow unsnooze <thread-id|--self>
bb jb-flow snoozed [--json]
bb jb-flow digest [--refresh] [--json]
bb jb-flow wait-ci [--pr <n>] [--repo owner/name] [--for checks|reviews|both] [--self|<thread-id>]
bb jb-flow wait-run <run-id|url> [--repo owner/name] [--self|<thread-id>]
bb jb-flow release-wait [--self|<thread-id>]
bb jb-flow prs [--self|<thread-id>] [--json]
bb jb-flow pr-link <pr-url> [--self|<thread-id>] [--remove]
bb jb-flow watches [--json]
bb jb-flow check-now
bb jb-flow your-move [--json] [--open]
bb jb-flow pr-radar [--json] [--open]
bb jb-flow deck                 # one cheap JSON snapshot for the Stream Deck
bb jb-flow leftovers [--refresh] [--json] [--clean]
bb jb-flow states [--json]     # every thread's state (Running, Needs me, Autopilot, Ready) and why, with counts
bb jb-flow classify            # debug: where every open thread lands, with its last message
bb jb-flow focused [--json]
bb jb-flow decisions [<thread-id>] [--json]
bb jb-flow tell <text…> [--thread <id>]
bb jb-flow stop [<thread-id>|--focused]
bb jb-flow needs-me [--json]
bb jb-flow next
bb jb-flow repo [--self|<thread-id>]
bb jb-flow repo-run <command-id|script:<name>> [--self|<thread-id>]
bb jb-flow repo-stop <command-id|script:<name>> [--self|<thread-id>]
bb jb-flow repo-config <project-name> '<json>'|reset
```

## Development

```sh
npm run typecheck
npm test
```

Several bb APIs used here are `experimental_` and may change between bb releases.
