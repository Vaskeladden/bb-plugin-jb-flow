import { idleFor, THREAD_STATE_LABEL, type ThreadStateId } from "./thread-states";

/** Longest prompt Update status or Donkey may send into a thread (the thread_reply contract). */
export const THREAD_REPLY_MAX = 8000;

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
  "If a pull request is ready to review, merge or ship and this repo has the skills, never offer a manual merge or tell me to merge it. Ask it as a decision whose options start with the trigger word: `shipit · <what it does for me>` (runs /pr-shipit: the review loop, then the merge) and `polish · <what it does for me>` (runs /pr-polish: the same loop, no merge). Picking one sends that word. Name the one you recommend in **Next:** too.",
  "",
  "Before you suggest more, look at the whole feature, not just the last step. Tag each step (simpler), (same) or (adds), and prefer steps that remove or merge something. If Health is Entropy +2 or worse, or your last three steps all added something, step 1 must be: check the whole feature and simplify (the architecture-check skill, when the repo has it). When the goal is met, say \"Nothing pending.\" instead of inventing more work.",
  "",
  "If there are steps you can do yourself, recommend a path forward and offer them as a numbered list in a callout. Don't start them until I reply.",
  "> [!TIP]",
  "> **Path forward:** <one plain line>",
  "> 1. <step> · <why, a few words> (simpler)",
  "> 2. <step> · <why> (adds)",
  ">",
  "> Reply **go** for all, or **go 1,3**.",
  "",
  "If you need a decision from me instead, ask in the same place:",
  "> [!TIP]",
  "> **Decision needed:** <question in plain words>",
  "> 1. <option> · <why> (recommended)",
  "> 2. <option> · <why>",
  ">",
  "> Reply with the number.",
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
  "1. **Bottom line.** One or two short sentences: are we on track, how far along, and the one thing most likely to stop us. Then one bar of the whole job, split into done and checked · done but only claimed · in progress · blocked · not started · dropped, counted in pieces.",
  "2. **Matrix.** The heart of the report: one row per piece of work, grouped by workstream, in plain names. Columns are the stages this job has, such as Built · Tested · Merged · Live. Each cell says checked, claimed, failed, blocked or not started, with the proof or the reason as its note (the Acceptance component fits). I must see at a glance what is finished and what is left.",
  "3. **What is left.** The remaining work in the order it should happen: what each step waits for, and which steps are mine. Use Steps, a Roadmap or a Board. Give sizes or dates only when you have a basis for them.",
  "4. **How it fits together.** Only when the job has parts that depend on each other: one Diagram of the parts, coloured or marked by state.",
  "5. **Gaps and surprises.** Where a check did not match the claim, what nobody owns, what was started and left, what got more complicated than the goal needs. A short list; leave it out when there is nothing.",
  "",
  "Words: each visual gets at most two or three short sentences in donkey language (plain everyday words, no jargon, no file names or ids unless I need them to act) that say what it means for the goal. Do not repeat in words what a visual already shows. No story of how you checked, no praise, no filler. If a thing is hard to explain, draw it.",
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
  "If a pull request is ready to review, merge or ship and this repo has the skills, never offer a manual merge or tell me to merge it. Ask it as a decision whose options start with the trigger word: `shipit · <what it does for me>` (runs /pr-shipit: the review loop, then the merge) and `polish · <what it does for me>` (runs /pr-polish: the same loop, no merge).",
  "",
  "Offer the steps you can do yourself as a numbered list in a callout, the ones that close the most of what is left first. Don't start them until I reply. When the goal is met, say \"Nothing pending.\" instead of inventing more work.",
  "> [!TIP]",
  "> **Path forward:** <one plain line>",
  "> 1. <step> · <why, a few words>",
  "> 2. <step> · <why>",
  ">",
  "> Reply **go** for all, or **go 1,3**.",
  "",
  "Ask each decision that is mine in its own callout:",
  "> [!TIP]",
  "> **Decision needed:** <question in plain words>",
  "> 1. <option> · <why> (recommended)",
  "> 2. <option> · <why>",
  ">",
  "> Reply with the number.",
].join("\n");

// What the Donkey button sends when the Donkey prompt setting is empty: the real
// problem in plain words with an example, then the decisions in the format
// "Your next move" turns into buttons (a report with Goal and Blocked, and one
// **Decision needed:** callout per question under ### Next steps).
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
  "Ask me each decision I must make in its own callout. Give two to four options, mark one recommended, and say in a few words what each option means for me:",
  "When a decision is about shipping or reviewing a pull request, start those options with the trigger word: `shipit · …` (review loop, then merge) and `polish · …` (same loop, no merge). Never offer a manual merge.",
  "> [!TIP]",
  "> **Decision needed:** <question in plain words>",
  "> 1. <option> · <what it means for me> (recommended)",
  "> 2. <option> · <what it means for me>",
  ">",
  "> Reply with the number.",
  "",
  "If nothing needs a decision from me, write **Next:** with what you will do instead, and leave out the callout.",
].join("\n");

// What the Revise button sends when the Revise prompt setting is empty: get a
// plan review from another model, picked by how hard the work is, and carry on
// with the better plan. Fable answers through the claude CLI; /second-opinion
// only reaches Codex from a Claude thread, so the two routes are spelled out.
export const DEFAULT_REVISE_PROMPT = [
  "Revise: get another model's view on the plan for this work, use it to guide what you do next, then carry on.",
  "",
  "1. Write a short brief to a file in this thread's storage: the goal, what is done, what is left, the plan you intend to follow, the risks you see and your open questions. Include the files and PRs that matter.",
  "2. Pick the reviewer by how hard the work is:",
  "   - **Fable 5.2** for the most complex work: architecture or design choices, several systems or repos at once, data or money at stake, a bug you can't explain, or a plan with many unknowns. Run it read-only from this thread's checkout, with the brief as the prompt: `claude -p \"$(cat <brief file>)\" --model claude-fable-5-2 --effort high --allowedTools Read Grep Glob` (the prompt goes first: --allowedTools takes every word after it), and ask it for the simplest plan that finishes the work, what is missing or risky, and what it would do differently.",
  "   - **Codex** for everything else (a clear fix, a review of a diff, a routine change): run /second-opinion with the brief.",
  "   Say in one line which one you picked and why.",
  "3. Compare its answer with your plan. Adopt what is better, keep what you can defend, and say in two to four short lines what changed and why.",
  "4. Continue the work with the revised plan. Ask me only about a decision that is truly mine.",
  "",
  "If the reviewer can't be reached, say so and continue with your own plan. Never write its answer yourself.",
].join("\n");

export function revisePrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_REVISE_PROMPT;
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

/** What the Status button sends: the report prompt, plus the child threads when the thread has any. */
export function statusRequest(setting: unknown, parentId: string, children: readonly ChildThread[], now: number = Date.now()): string {
  const section = childrenSection(parentId, children, now);
  return section ? `${statusPrompt(setting)}\n\n${section}` : statusPrompt(setting);
}

/** What the Ultrastatus button sends: the thorough report prompt, plus the child threads when the thread has any. */
export function ultrastatusRequest(setting: unknown, parentId: string, children: readonly ChildThread[], now: number = Date.now()): string {
  const section = ultrastatusChildrenSection(parentId, children, now);
  return section ? `${ultrastatusPrompt(setting)}\n\n${section}` : ultrastatusPrompt(setting);
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
