import { idleFor, THREAD_STATE_LABEL, type ThreadStateId } from "./thread-states";

/** Longest prompt Update status or Donkey may send into a thread (the thread_reply contract). */
export const THREAD_REPLY_MAX = 8000;

// How a report asks: genui ```ui blocks, which genui shows in "Your next move"
// under the chat until the user answers. A go-list is a Plan (approving it
// sends "Go ahead with the plan", or the steps kept); a decision is Buttons
// whose label is the answer; several decisions are one Form.
const PATH_FORWARD = [
  "```ui",
  'Card("Path forward: <one plain line>", [Plan([',
  '  {title: "<step>", detail: "<why, a few words> (simpler)"},',
  '  {title: "<step>", detail: "<why> (adds)"}',
  "])])",
  "```",
];
const DECISION = [
  "```ui",
  'Card("<question in plain words>", [Button("<option> · <why> (recommended)", variant: "primary"), Button("<option> · <why>")])',
  "```",
  "Several decisions: one Card with one Form holding a Radio per question, the recommended option first.",
];

// What the Status button sends when the Status report prompt setting is empty.
// The thread monitor parses these fields (see thread-status.ts).
export const DEFAULT_STATUS_PROMPT = [
  "Give a short status report in exactly this format, then stop. Leave out any line or section with nothing real to say.",
  "",
  "Write it in donkey language: very short sentences, plain everyday words someone who does not code gets at once. No file names, ids, function names or jargon unless I need them to act. Put a blank line between the fields, so each one shows on its own line.",
  "",
  "**Goal:** <what we are trying to get, one short sentence>",
  "",
  "**Done:** <what just happened, one short sentence>",
  "",
  "**Next:** <the next step, or \"Nothing pending.\">",
  "",
  "**Blocked:** <only if blocked: waiting for what or whom>",
  "",
  "**State:** <one of: Running (you keep working after this) · Needs me (you can't go on without my answer) · Autopilot (it goes on without me: CI, a deploy, another person) · Ready (nothing left for you)>",
  "",
  "**Health:** <only if this thread changed code: the whole branch so far, not just the last step. Entropy −2…+2 (− simpler, + more machinery or duplication) · Performance −2…+2 (runtime work or waiting) · Vision: supports, mixed, deviates or unknown. One short reason each.>",
  "",
  "### Progress",
  "One fenced block, one line per milestone, each named in a few plain words:",
  "```",
  "[██████████] Milestone A   done",
  "[██████░░░░] Milestone B   60%  ← here",
  "[░░░░░░░░░░] Milestone C",
  "```",
  "",
  "### Next steps",
  "Ask in ```ui blocks: they show in Your next move under the chat, where I answer. If a pull request is ready to review, merge or ship and this repo has the skills, never offer a manual merge or tell me to merge it. Ask it as a decision whose buttons start with the trigger word: `shipit · <what it does for me>` (runs /pr-shipit: the review loop, then the merge) and `polish · <what it does for me>` (runs /pr-polish: the same loop, no merge). Picking one sends its label. Name the one you recommend in **Next:** too.",
  "",
  "Before you suggest more, look at the whole feature, not just the last step. Tag each step (simpler), (same) or (adds), and prefer steps that remove or merge something. If Health is Entropy +2 or worse, or your last three steps all added something, step 1 must be: check the whole feature and simplify (the architecture-check skill, when the repo has it). When the goal is met, say \"Nothing pending.\" instead of inventing more work.",
  "",
  "If there are steps you can do yourself, recommend a path forward: one plain line, then the steps as a Plan I approve, untick or change. Don't start them until I reply.",
  ...PATH_FORWARD,
  "",
  "If you need a decision from me instead, ask it the same way:",
  ...DECISION,
].join("\n");

// What the Ultrastatus button sends when the Ultrastatus prompt setting is empty:
// the heavy version of Status. The agent rebuilds the whole job from the thread
// and its child threads, checks every claim against its source, and reports
// mostly in visuals. It still ends with the fields the thread monitor reads.
export const DEFAULT_ULTRASTATUS_PROMPT = [
  "Ultrastatus: give me a thorough, checked status report on this whole job, shown mostly as visuals (bars, a matrix, diagrams), then stop.",
  "",
  "I use this to see how we track toward the overall goal, and I must be able to trust every line. Take the time and the tokens it needs. Do the three steps in order. Steps 1 and 2 only read: no edits, commits, pushes or merges, and no messages to other threads.",
  "",
  "## 1. Rebuild the whole job",
  "- **The overall goal:** what I asked for when this thread started, and every time I widened, narrowed or changed it. Use the whole thread, not the last task. If early parts were summarized away, read them back (the transcript, or `bb thread log --self --all`) instead of guessing.",
  "- **Every piece of work toward it:** each thing I asked for, each workstream, each child thread, each pull request. Include what was dropped, parked or replaced, and who decided. Archived child threads count too: `bb thread list --parent-thread \"$BB_THREAD_ID\" --include-archived` lists them.",
  "- **What waits for me:** every question you or a child asked that I never answered.",
  "",
  "## 2. Check each piece against its source",
  "Earlier messages, yours and the children's, are claims. Look at the thing itself now:",
  "- A pull request: its state, its checks and whether it merged.",
  "- \"Shipped\", \"live\", \"installed\" or \"deployed\": what is really running or installed, and from which commit.",
  "- \"Tests pass\": a run on the current code, or run them.",
  "- \"Fixed\": the thing that was broken, tried again.",
  "- A child thread: what it actually delivered, not what its title or last line says.",
  "Give every piece one of: **checked** (you saw the proof now; name it in a few words), **claimed** (said, but you could not check; say why), **not done**, **blocked** or **dropped**. Never round up: half done is not done, merged is not live, and a claim is not a check. When what you find differs from what was said earlier, that goes in the report.",
  "If you can run subagents, use them for the checks that can run side by side. Hand each one the claim to test and where to look, never your conclusion, and read their evidence yourself before you rely on it.",
  "",
  "## 3. Report",
  "Visuals first. If this chat renders inline UI blocks (you were given a ```ui reference), build the report from those components and check the blocks before you send. If not, use fenced bar blocks and markdown tables. Write in the language I write to you in.",
  "",
  "In this order, leaving out a part with nothing real in it:",
  "1. **Bottom line.** One or two short sentences: are we on track, how far along, and the one thing most likely to stop us. Then one bar of the whole job, split into done and checked · done but only claimed · in progress · blocked · not started · dropped, counted in pieces. On a bug thread, the bug tracker of the status board layout takes the bar's place (the `show_board` tool's instructions; without the tool, `bb genui show-board --help` prints it; with neither, keep the bar).",
  "2. **Matrix.** The heart of the report: one row per piece of work, grouped by workstream, in plain names. Columns are the stages this job has, such as Built · Tested · Merged · Live. Each cell says checked, claimed, failed, blocked or not started, with the proof or the reason as its note (the Acceptance component fits). I must see at a glance what is finished and what is left. On a bug thread the tracker already shows the fix's stages and their proof: the matrix holds only other work, and is left out when there is none.",
  "3. **What is left.** The remaining work in the order it should happen: what each step waits for, and which steps are mine. Use Steps, a Roadmap or a Board. Give sizes or dates only when you have a basis for them.",
  "4. **How it fits together.** Only when the job has parts that depend on each other: one Diagram of the parts, coloured or marked by state.",
  "5. **Gaps and surprises.** Where a check did not match the claim, what nobody owns, what was started and left, what got more complicated than the goal needs. A short list; leave it out when there is nothing.",
  "",
  "Words: each visual gets at most two or three short sentences in donkey language (plain everyday words, no jargon, no file names or ids unless I need them to act) that say what it means for the goal. No commit hashes, pull request numbers or branch names in the prose: the proof goes in the matrix cells' notes. Do not repeat in words what a visual already shows. No story of how you checked, no praise, no filler. If a thing is hard to explain, draw it.",
  "",
  "End with the short fields below, so the thread monitor stays current. They replace the usual status report for this reply. They cover the whole job, and Done and Next must match the matrix.",
  "",
  "**Goal:** <the overall goal, one short sentence>",
  "",
  "**Done:** <what is finished and checked, one short sentence>",
  "",
  "**Next:** <the next step, or \"Nothing pending.\">",
  "",
  "**Blocked:** <only if blocked: waiting for what or whom>",
  "",
  "**State:** <one of: Running (you keep working after this) · Needs me (you can't go on without my answer) · Autopilot (it goes on without me: CI, a deploy, another person) · Ready (nothing left for you)>",
  "",
  "### Progress",
  "One fenced block, one line per workstream, each named in a few plain words. A workstream is done only when every piece in it is checked:",
  "```",
  "[██████████] Workstream A   done",
  "[██████░░░░] Workstream B   60%  ← here",
  "[░░░░░░░░░░] Workstream C",
  "```",
  "",
  "### Next steps",
  "Ask in ```ui blocks: they show in Your next move under the chat, where I answer. If a pull request is ready to review, merge or ship and this repo has the skills, never offer a manual merge or tell me to merge it. Ask it as a decision whose buttons start with the trigger word: `shipit · <what it does for me>` (runs /pr-shipit: the review loop, then the merge) and `polish · <what it does for me>` (runs /pr-polish: the same loop, no merge).",
  "",
  "Offer the steps you can do yourself as a Plan, the ones that close the most of what is left first. Don't start them until I reply. When the goal is met, say \"Nothing pending.\" instead of inventing more work.",
  ...PATH_FORWARD,
  "",
  "Ask each decision that is mine:",
  ...DECISION,
].join("\n");

// What the Donkey button sends when the Donkey prompt setting is empty: the real
// problem in plain words with an example, then the decisions as ```ui blocks,
// which genui shows in "Your next move" (a report with Goal and Blocked, and
// the questions under ### Next steps).
export const DEFAULT_DONKEY_PROMPT = [
  "What is the real problem here? Explain it to me like I'm a donkey, then stop.",
  "",
  "Use very short sentences and plain everyday words. No file names, ids, function names or jargon. Use a concrete example from this work: what happens today, step by step, and what goes wrong. Write in the language I write to you in.",
  "",
  "Use exactly this format, with a blank line between the fields:",
  "",
  "**Goal:** <what we are trying to get, one short sentence>",
  "",
  "**Blocked:** <the problem in one short sentence>",
  "",
  "### The problem",
  "<two to five short sentences: what is wrong and why it matters>",
  "",
  "### Example",
  "<a concrete example: what happens today, and what should happen instead>",
  "",
  "### Next steps",
  "Ask me each decision I must make in a ```ui block; it shows in Your next move under the chat. Give two to four options, the recommended one first, and say in a few words what each option means for me:",
  "When a decision is about shipping or reviewing a pull request, start those options with the trigger word: `shipit · …` (review loop, then merge) and `polish · …` (same loop, no merge). Never offer a manual merge.",
  ...DECISION,
  "",
  "If nothing needs a decision from me, write **Next:** with what you will do instead, and leave out the block.",
].join("\n");

// What the Revise button sends when the Revise prompt setting is empty: a plan
// review from a model of the other family, then carry on with the better plan.
// A model never reviews its own family (owner, 2026-11-23): a Claude thread asks
// Codex, every other thread asks Fable 5.2 through the claude CLI.
export type ReviseReviewer = "codex" | "fable";

export function reviseReviewer(providerId: string | null): ReviseReviewer {
  return providerId === "claude-code" ? "codex" : "fable";
}

const REVISE_ASK = "the simplest plan that finishes the work, what is missing or risky, and what it would do differently";

const REVISE_ROUTE: Record<ReviseReviewer, string> = {
  codex: `2. Ask **Codex**: you run on Claude, and a model never reviews its own family. Run /second-opinion with the brief, and ask for ${REVISE_ASK}.`,
  fable: `2. Ask **Fable 5.2**: you do not run on Claude, and a model never reviews its own family. Run it read-only from this thread's checkout, with the brief as the prompt: \`claude -p "$(cat <brief file>)" --model claude-fable-5-2 --effort high --allowedTools Read Grep Glob\` (the prompt goes first: --allowedTools takes every word after it), and ask for ${REVISE_ASK}.`,
};

export function defaultRevisePrompt(reviewer: ReviseReviewer): string {
  return [
    "Revise: get another model's view on the plan for this work, use it to guide what you do next, then carry on.",
    "",
    "1. Write a short brief to a file in this thread's storage: the goal, what is done, what is left, the plan you intend to follow, the risks you see and your open questions. Include the files and PRs that matter.",
    REVISE_ROUTE[reviewer],
    "3. Compare its answer with your plan. Adopt what is better, keep what you can defend, and say in two to four short lines what changed and why.",
    "4. Continue the work with the revised plan. Ask me only about a decision that is truly mine.",
    "",
    "If the reviewer can't be reached, say so and continue with your own plan. Never ask a model of your own family instead, and never write its answer yourself.",
  ].join("\n");
}

/** The user's own Revise prompt when set, else the built-in one for the thread's agent. */
export function revisePrompt(setting: unknown, providerId: string | null): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : defaultRevisePrompt(reviseReviewer(providerId));
}

export function donkeyPrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_DONKEY_PROMPT;
}

export function ultrastatusPrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_ULTRASTATUS_PROMPT;
}

export function statusPrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_STATUS_PROMPT;
}

/** A thread below the one asked for status, with what bb knows about it. */
export type ChildThread = {
  id: string;
  title: string;
  /** The thread it was started from, when that is not the thread asked. */
  under: string | null;
  state: ThreadStateId;
  reason: string;
  goal: string;
  next: string;
  blocked: string;
  /** Start of its last reply, for a child that never wrote a report. */
  latest: string;
  /** When it last reported or replied; null when it never did. */
  heardAt: number | null;
};

/** Most child threads a status request lists; the rest are counted. */
export const CHILD_ROWS_MAX = 30;
// Those that wait for me first; finished ones are the first to be left out.
const CHILD_ORDER: readonly ThreadStateId[] = ["needs", "running", "autopilot", "parked", "ready", "done"];
const brief = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** Most child threads an Ultrastatus request lists: it checks the finished ones too. */
export const ULTRA_CHILD_ROWS_MAX = 80;

/** The child threads as bb knows them now: a count per state, then one line each. */
function childrenList(parentId: string, children: readonly ChildThread[], now: number, max: number): string[] {
  const sorted = [...children].sort((a, b) => CHILD_ORDER.indexOf(a.state) - CHILD_ORDER.indexOf(b.state));
  const listed = sorted.slice(0, max);
  const counts = CHILD_ORDER.map((state) => [state, children.filter((child) => child.state === state).length] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${THREAD_STATE_LABEL[state]}`)
    .join(" · ");
  const row = (child: ChildThread) => {
    const parts = [`${child.id} "${brief(child.title, 70) || "Untitled"}"`, `${THREAD_STATE_LABEL[child.state]} (${brief(child.reason, 90)})`];
    if (child.under !== null) parts.push(`started from ${child.under}`);
    if (child.state !== "done") {
      if (child.goal) parts.push(`Goal: ${brief(child.goal, 110)}`);
      if (child.next) parts.push(`Next: ${brief(child.next, 130)}`);
      if (child.blocked) parts.push(`Blocked: ${brief(child.blocked, 130)}`);
      if (!child.goal && !child.next && child.latest) parts.push(`Last said: ${brief(child.latest, 160)}`);
      parts.push(child.heardAt === null ? "no reply yet" : `heard ${idleFor(now - child.heardAt)} ago`);
    }
    return `- ${parts.join(" · ")}`;
  };
  const left = sorted.length - listed.length;
  return [
    `What bb knows about them now (state, why, and what each last reported). ${children.length} child ${children.length === 1 ? "thread" : "threads"}: ${counts}.`,
    "",
    ...listed.map(row),
    ...(left > 0 ? [`- ${left} more not listed, the least urgent ones. \`bb thread list --parent-thread ${parentId}\` lists them all.`] : []),
  ];
}

/**
 * What a status request adds in a thread that has child threads: each child's
 * state and last report, and how to weigh them. Empty without children.
 */
export function childrenSection(parentId: string, children: readonly ChildThread[], now: number = Date.now()): string {
  if (children.length === 0) return "";
  return [
    "---",
    "",
    "This thread has child threads, and I steer them from here. So this report covers them too.",
    "",
    ...childrenList(parentId, children, now, CHILD_ROWS_MAX),
    "",
    "How to use it:",
    "- The list can be old or thin. For a child that is not done and whose line does not tell you where it stands, read its last reply with `bb thread output <id>` before you write. Only read: do not message a child to write this report.",
    "- **Goal**, **Done**, **Next** and **Blocked** are about the whole job: this thread and its children together. **State** is still about this thread alone.",
    "- Under `### Progress`, after your own milestones, give each child that is not done its own line, named by what it does in a few plain words. Count the finished ones in one line (\"14 of 29 child threads done\").",
    "- Add a section `### Children` between Progress and Next steps. One line per child that is not done, those that wait for me first: `**<what it does>** · <state> · <what it does now, or what it waits for>`. End with one line for the finished ones.",
    "- Under `### Next steps`, include what moves the children: answer a child's question, tell one to go on, ship one's pull request, stop one nobody needs. Name the child in each step. When I reply go, do those steps by messaging the child (`bb thread tell <id> '<message>'`). Do not message them before that.",
  ].join("\n");
}

/**
 * What an Ultrastatus request adds in a thread that has child threads: the same
 * list, and the rule that every child is read and its result checked.
 */
export function ultrastatusChildrenSection(parentId: string, children: readonly ChildThread[], now: number = Date.now()): string {
  if (children.length === 0) return "";
  return [
    "---",
    "",
    "This thread has child threads, and I steer the job from here. Their work is part of the job, so the report covers all of it.",
    "",
    ...childrenList(parentId, children, now, ULTRA_CHILD_ROWS_MAX),
    "",
    "How to use it:",
    "- The list is where you start, not the answer: it can be old, thin or wrong. Read every child that is not done (`bb thread output <id>` for its last reply, `bb thread log <id>` when that does not say where it stands). A child \"started from\" another child is that child's own child thread; it counts too.",
    "- A finished child is a claim like any other. Check that what it delivered really landed: its pull request merged, its result is in use. Do this for every finished child the goal depends on, and say which ones you did not check.",
    "- Only read. Do not message a child to write this report.",
    "- Each child's work is a row in the matrix, under the workstream it belongs to, named by what it does and not by its id. Several children on one piece of work share a row. With many finished children, a workstream may show them as one checked row with a count.",
    "- After the matrix, show the children that are not done (a `Threads()` block shows them live when the chat renders UI), those that wait for me first, with what each does now or waits for.",
    "- **Goal**, **Done**, **Next**, **Blocked** and `### Progress` are about the whole job: this thread and its children together. **State** is still about this thread alone.",
    "- Under `### Next steps`, include what moves the children: answer a child's question, tell one to go on, ship one's pull request, stop one nobody needs. Name the child in each step. When I reply go, do those steps by messaging the child (`bb thread tell <id> '<message>'`). Do not message them before that.",
  ].join("\n");
}

/**
 * What a status request adds when the thread has a status board (the genui
 * plugin's side-panel tab): bring it up to date as well, as an update. It says
 * so in the request itself, so an agent whose session started before the board
 * plugin told it to keep the board current still does it.
 */
export function statusBoardSection(title: string): string {
  return [
    "---",
    "",
    `This thread has a status board in my side panel («${title}»). After the report, bring it up to date too:`,
    "- Read it with `bb genui board`, change only what moved since its last version, and publish it with the `show_board` tool, `mode: \"update\"` and `kind: \"update\"`. Without that tool, write it to `$BB_THREAD_STORAGE/board.md` and run `bb genui show-board '$BB_THREAD_STORAGE/board.md'`.",
    "- Lay it out as the status board layout says (the tool's instructions, or `bb genui show-board --help`): the five «In plain words» lines first, in donkey language.",
    "- This is an update, not an Ultrastatus: write from what you know, don't check every row again, and never call it an Ultrastatus.",
    "- If nothing on the board changed since its last version, leave it as it is.",
  ].join("\n");
}

/**
 * What the Status button sends: the report prompt, plus the child threads when
 * the thread has any, plus the board update when it has a status board
 * (`board` is its title; null without one).
 */
export function statusRequest(
  setting: unknown,
  parentId: string,
  children: readonly ChildThread[],
  now: number = Date.now(),
  board: string | null = null,
): string {
  const sections = [childrenSection(parentId, children, now), board === null ? "" : statusBoardSection(board)];
  return [statusPrompt(setting), ...sections.filter((section) => section !== "")].join("\n\n");
}

/** Where an Ultrastatus report goes on the thread's status board: a new version of the board that is there, or a new board. */
export type BoardMode = "update" | "new";

/**
 * What an Ultrastatus request adds when the report goes on the thread's status
 * board (the genui plugin's side-panel tab, filled with its show_board tool)
 * instead of in the reply: how to publish it, what an update keeps from the
 * board that is there, that its next steps and decisions are controls the user
 * can act on from the side panel, and what little the reply still holds. An agent without
 * the board reports in its reply as before.
 */
export function ultrastatusBoardSection(mode: BoardMode): string {
  return [
    "---",
    "",
    "Put the report on this thread's status board, not in your reply. The board is a tab in my side panel that opens by itself and stays there; a reply scrolls away.",
    "",
    "- Lay the board out as the status board layout says (the `show_board` tool's instructions; without the tool, `bb genui show-board --help` prints it). Step 3's bottom line becomes its «In plain words» lines; then come the bar (on a bug thread, the layout's bug tracker instead) and the «Next» card; then the matrix, what is left, how it fits together and the gaps, each under its plain question with a sentence or two on what it means.",
    `- Everything step 3 asks for is one board. Publish it with the \`show_board\` tool: the report as \`content\` (markdown with its \`\`\`ui blocks), \`mode: "${mode}"\` and \`kind: "ultrastatus"\`, since this run checks every row. Without that tool, write the report to \`$BB_THREAD_STORAGE/board.md\` and run \`bb genui show-board '$BB_THREAD_STORAGE/board.md'${mode === "new" ? " --new" : ""} --ultrastatus\`. If this bb has neither, put the report in your reply as step 3 says and skip the rest of this section.`,
    ...(mode === "update"
      ? [
          "- This run updates the board that is there. Read it first with `bb genui board`. Keep its title, its rows, their names and their order, so I can compare with last time; on a bug thread the layout's tracker rules on the title and on older bar rows come first. Add rows for new work; never drop a row silently, mark it dropped.",
          "- A mark copied from the old board is a claim, not a check: every row is checked again now, as step 2 says. Versions since the last Ultrastatus may be updates written from the work without any check.",
          "- «What changed since last time» compares with the board's last version, in plain words, or says that nothing changed. If there is no board yet, start one, with a title of a few words naming the job.",
        ]
      : [
          "- This run starts a new board: build it from scratch, with a title of a few words naming the job. Do not copy the old board; it stays in the history.",
        ]),
    "- The board is also where I go on with the work, so everything I can act on is a control I can press, never only a sentence. Right after the bar or the bug tracker, put one card named «Next» with: the steps you can do yourself as Buttons (one per step, and one for all of them), or as a Plan when they need my approval; each decision that is mine as Buttons, a Decision or a Form; and for a pull request that is ready, Buttons labelled with the trigger words `shipit` and `polish`, with what each does as text beside them. A Button without an action sends its label as my answer, so the label must stand alone as an instruction to you and stay under about 30 characters, because a phone cuts a longer one (\"Do step 1: fix the test\", \"Do all three steps\", \"shipit\"); say the rest in text beside it, or give the Button `Send(text)` as its action to send a longer ready-made message under a short label. What I pick lands in this thread's message field, and I send it from the board. Offer only real next steps; when the goal is met, the card says «Nothing pending.»",
    "- A block that fails its check stores nothing: fix what the answer names and publish again.",
    "- In your reply write only the bottom line in one or two sentences and that the full report is on the status board, then the closing fields, `### Progress` and `### Next steps` exactly as described above, so I can answer from the chat. Do not repeat the matrix or the other visuals in the reply.",
  ].join("\n");
}

/**
 * What the Ultrastatus buttons send: the thorough report prompt, where the
 * report goes when it goes on the status board, plus the child threads when
 * the thread has any.
 */
export function ultrastatusRequest(
  setting: unknown,
  parentId: string,
  children: readonly ChildThread[],
  now: number = Date.now(),
  board: BoardMode | null = null,
): string {
  const sections = [board === null ? "" : ultrastatusBoardSection(board), ultrastatusChildrenSection(parentId, children, now)];
  return [ultrastatusPrompt(setting), ...sections.filter((section) => section !== "")].join("\n\n");
}

/**
 * Thread instructions for the "Status report at hand-back" setting: the agent
 * ends replies that hand the thread back with the report, so the thread
 * monitor stays current without clicking Update status.
 */
export function handBackInstructions(setting: unknown): string {
  return [
    "## Status report when you hand back",
    "When you end a turn that hands the thread back to the user (the work is done, you're blocked, or you need their input or approval), end that reply with a status report in the format below, after your normal reply. Skip it for short answers to quick questions and while work is still in progress. Don't repeat in prose what the report already says.",
    "",
    "Format:",
    "",
    statusPrompt(setting),
  ].join("\n");
}
