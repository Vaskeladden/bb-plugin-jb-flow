// What "Update status" sends when the Status report prompt setting is empty.
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

export function donkeyPrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_DONKEY_PROMPT;
}

export function statusPrompt(setting: unknown): string {
  return typeof setting === "string" && setting.trim() !== "" ? setting : DEFAULT_STATUS_PROMPT;
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
