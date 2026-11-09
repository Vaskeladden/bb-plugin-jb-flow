// Classifies an idle thread's final agent message: did it end with an actual
// question to the user (a sentence ending in "?", or inline answer controls),
// or is the work wrapped up? Menus of next steps ("pick one", "Reply go for
// all") are not questions; the owner only wants real questions in Needs me.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { lastReply, turnReply } from "./turn-reply.ts";
import { laneSections } from "./lanes.ts";
import { parseStatusReport, reportsNothingPending } from "./thread-status.ts";

const AWAITING_VERSION = 17;

/** Curly apostrophes as straight ones, so "I’ll" matches like "I'll". */
const straight = (text: string) => text.replace(/[’‘]/g, "'");

// Inline UI (```ui) asks with controls: a Form, a Plan or Decision to approve,
// or a Button without an action, whose label becomes your answer. Buttons that
// open a link and FollowUps (suggested next questions) don't ask anything.
const UI_BLOCK = /```ui\b[\s\S]*?```/g;
const UI_ASK = /\b(?:Form|Plan|Decision)\(|\bButton\(\s*"[^"]*"\s*(?:,\s*variant:[^,)]*)?\)/;

export function asksWithControls(text: string): boolean {
  return [...text.matchAll(UI_BLOCK)].some((block) => UI_ASK.test(block[0]));
}

// A decision label, then a question on the same line.
const DECISION_QUESTION =
  /\*\*(?:your (?:decision|call)|decision needed|din (?:beslutning|avgjørelse)|beslutning(?: trengs)?|du må (?:velge|avgjøre))\b[^\n]*\?(?=["”»'*_)\]]*(?:\s|$))/i;

// A question mark that ends a sentence, allowing closing quotes, emphasis or
// brackets after it. "?" inside a URL or a word ("a?b") doesn't count.
const QUESTION = /\?(?=["”»'*_)\]]*(?:\s|$))/;

/** True when the end of the message asks the user an actual question. */
export function asksUser(text: string): boolean {
  text = straight(text);
  if (asksWithControls(text)) return true;
  // Code and UI blocks, inline code and links can hold "?" that nobody asks:
  // suggested follow-ups, query strings, quoted output.
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    // A bold "why" lead-in ("**Why does it fail?** The dispatcher…") explains;
    // it doesn't ask. Other bold questions ("**Skal Sander betale?** Jeg
    // anbefaler ja.") still ask, even with a recommendation after them.
    .replace(/\*\*(?:why|hvorfor|how come)\b[^*\n]*\?\*\*/gi, " ")
    .trim();
  // A labelled decision ("**Your decision:** which…?") asks wherever it sits:
  // agents often put the question first and the evidence after it.
  return QUESTION.test(prose.slice(-900)) || DECISION_QUESTION.test(prose) || WAITS_ON_YOU.test(prose.slice(-900));
}

// Asks without a question mark: "still waiting for your reply", a step list
// whose next step is "**You:** approve the draft". A plain menu ("**Your
// decision:** pick one, and I'll wait for your reply") is not one (2026-11-05).
// "Waiting for your next message" is only a sign-off: nothing to decide.
const WAITS_ON_YOU =
  /\b(?:waits|waiting) (?:for|on) your (?:reply|answer|decision|call|input|approval|go)\b|\bnext decision:|^\s*(?:\d+\.|[-*])\s+\*\*You:\*\*/im;

// The agent said it would come back on its own ("I'll report when it finishes",
// "I'm checking every 30 seconds"). If the thread then stays idle, nothing is
// actually running and the promise is stalled: you have to nudge it.
const PROMISES = new RegExp(
  [
    String.raw`\bi('ll| will) (report|tell you|let you know|update you|check back|ping you|confirm|post)\b[^.\n]{0,60}\b(when|once|after|as soon as)\b`,
    String.raw`\bi('ll| will) (report|let you know|tell you) (back|the result)`,
    String.raw`\bi'm (checking|watching|polling|monitoring|waiting for)\b`,
    String.raw`\bi'm (still )?waiting on (that|the|it)\b`,
    String.raw`\b(is|are) (running|still running) in the background\b`,
    String.raw`\bwill report when\b`,
    String.raw`\bi('ll| will) (check|look at|verify)\b[^.\n]{0,60}\bthen\b`,
    String.raw`\b(a|the) background (job|watcher|task) will\b`,
    String.raw`\b(daily|hourly|nightly|next) [^.\n]{0,20}\b(recheck|check|run) will (confirm|show|tell)\b`,
    String.raw`\bi('ll| will) bring it to you\b`,
    // Norwegian: "jeg får beskjed når den er ferdig", "jeg følger med på…", "jeg melder fra når…".
    String.raw`\bjeg (får beskjed|blir varslet|melder fra|sier fra|gir beskjed|rapporterer|følger opp)\b[^.\n]{0,80}\b(når|så snart|etter at|etter)\b`,
    String.raw`\bjeg (følger med på|venter på|sjekker igjen)`,
    String.raw`\b(sier|melder|gir) (fra|beskjed) (når|så snart)\b`,
    String.raw`\bi bakgrunnen\b`,
  ].join("|"),
  "i",
);

/** True when the message ends with the agent promising to follow up by itself. */
export function promisesFollowUp(text: string): boolean {
  text = straight(text);
  return PROMISES.test(text.trim().slice(-600)) && !asksUser(text);
}

// The next move is someone else's: a reviewer, a customer, a colleague. Names
// are capitalised words; "you" is excluded (that's an ask, handled above).
const PERSON = String.raw`(?:he|she|they|(?!(?:You|It|This|That|These|Those|We|There|Then|Once|When|CI|GitHub|Vercel|Linear|Sentry|Slack)\b)\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+)?)`;
const WAITS = new RegExp(
  [
    String.raw`\b([Ww]aiting|[Ww]ait) (for|on) (?![Yy]our?\b|CI\b|ci\b|(the|that) CI\b|[Cc]hecks?\b|(the|that|it|a|its|all) (CI|build|deploy|release|certificate|run|job|result|pipeline|tests?|workflows?|suite|checks?|migration|merge|GitHub Actions)\b|release\b|deploy\b|pipeline\b|tests?\b|workflows?\b|GitHub Actions\b|[Aa]ctions\b)\w`,
    String.raw`\b([Oo]nce|[Ww]hen|[Uu]ntil|[Aa]fter) ${PERSON} (replies|responds|answers|confirms|approves|reviews|sends|signs|gets back|has (replied|answered|confirmed|reviewed))`,
    String.raw`\b(depends on|is up to|pending on|[Bb]locked on) ${PERSON}\b`,
    String.raw`\b(only )?pending reviewers?\b|\bawaiting (review|a reply|reply|response|approval|their|his|her)\b`,
    String.raw`\b(no|nothing|not) (reply|answer|response) (yet )?from\b`,
    String.raw`\b(check|look) (for|whether|if) (${PERSON}(’s|'s)? (reply|answer|response)|${PERSON} (replied|answered|responded|has (replied|answered)))`,
    String.raw`\b${PERSON} (still )?(hasn't|hasn’t|has not|haven't|haven’t) (answered|replied|responded|got back)`,
    String.raw`\bcheck (the [^.\n]{0,40} )?(thread|inbox|mail|email|channel) for (${PERSON}(’s|'s)?|a|any|their|his|her) (reply|answer|response)`,
    String.raw`\b${PERSON} (can|needs to|has to|should|will) (now )?(push|send|review|approve|sign|reply|confirm|answer|check|merge|decide)\b`,
    String.raw`\b([Aa]sked|[Ee]mailed|[Pp]inged|[Mm]essaged|[Nn]udged) ${PERSON}\b[^.\n]{0,60}\b(waiting|reply|answer|back)\b`,
  ].join("|"),
  "u",
);

// "Tell me when he replies", "Reply go with his answer": your only part is to
// pass someone else's answer on, so the thread is really waiting on them.
const RELAY = new RegExp(
  [
    String.raw`\b(tell me|let me know|paste (it|his|her|their)?|reply|say)\b[^.\n]{0,50}\b(when|once|after) ${PERSON} (replies|answers|responds|confirms|gets back|has replied)`,
    String.raw`\b([Oo]nce|[Ww]hen|[Aa]fter) ${PERSON} (replies|answers|responds|confirms|gets back)[^.\n]{0,40}\b(tell me|let me know|say|reply|paste)\b`,
    String.raw`\b(with|paste) (his|her|their) (answer|reply|response)\b`,
  ].join("|"),
  "u",
);

export function relaysOthers(text: string): boolean {
  return RELAY.test(straight(text).trim().slice(-600));
}

/** True when the message hands the next step to someone other than you. */
export function waitsOnOthers(text: string): boolean {
  text = straight(text);
  if (relaysOthers(text)) return true;
  return WAITS.test(text.trim().slice(-700)) && !asksUser(text);
}

// A marker that stops the work until you act: "**BLOCKED:** …", a shipit
// stop. Nothing resolves it by itself, so it is Needs me, never Autopilot.
const BLOCKER = /(?:^|\n)\s*(?:[-*]\s+)?\**BLOCKED\b|\bFOLLOW_UP_REQUIRED\b|\bSHIPIT-BLOCKED\b/;

/** True when the message ends on a blocker only you can clear. */
export function blocksOnUser(text: string): boolean {
  return BLOCKER.test(straight(text).trim().slice(-1500));
}

/** The state a status report names on its "**State:**" line; Running names none (the turn has ended). */
export function reportedState(text: string): "needs_you" | "autopilot" | "ready" | undefined {
  const value = /^\s*(?:[-*]\s+)?\*\*State:\*\*\s*(.+)$/im.exec(straight(text))?.[1]?.toLowerCase() ?? "";
  if (/\bneeds me\b/.test(value)) return "needs_you";
  if (/\bautopilot\b/.test(value)) return "autopilot";
  if (/\bready\b/.test(value)) return "ready";
  return undefined;
}

/** What a finished turn's last message says, when the agent declared nothing. */
export function wordingFlags(text: string): { asks: boolean; promised: boolean; waiting: boolean } {
  if (reportsNothingPending(parseStatusReport(text, Date.now()))) return flagsFor("ready");
  const stated = reportedState(text);
  if (stated) return flagsFor(stated, text);
  const asks = (asksUser(text) || blocksOnUser(text)) && !relaysOthers(text);
  return {
    asks,
    promised: !asks && promisesFollowUp(text),
    waiting: !asks && waitsOnOthers(text),
  };
}

export { STALLED_AFTER_MS } from "./thread-states.ts";

/**
 * What the agent says as its turn ends (the `thread_state` tool): needs_you,
 * autopilot or ready. The older will_report_back / waiting_on_others (both
 * autopilot) and done (ready) are still accepted from sessions that know them.
 */
export const DECLARED_STATES = ["needs_you", "autopilot", "ready", "will_report_back", "waiting_on_others", "done"] as const;
export type DeclaredState = (typeof DECLARED_STATES)[number];

/** The new name for an older declared state. */
export function declaredState(state: DeclaredState): "needs_you" | "autopilot" | "ready" {
  if (state === "will_report_back" || state === "waiting_on_others") return "autopilot";
  if (state === "done") return "ready";
  return state;
}

/**
 * The three flags a declared state sets; the agent's own words beat any pattern.
 * Autopilot waits on someone else when its note or reply says so (that never
 * goes stale); otherwise the agent continues by itself, and an idle promise
 * with nothing watching turns into Needs me after an hour.
 */
export function flagsFor(state: DeclaredState, text = ""): { asks: boolean; promised: boolean; waiting: boolean } {
  // A blocker only you can clear is never Autopilot, whatever the agent said.
  if (declaredState(state) === "autopilot" && blocksOnUser(text)) return { asks: true, promised: false, waiting: false };
  const others = state === "waiting_on_others" || (state === "autopilot" && waitsOnOthers(text));
  return { asks: state === "needs_you", promised: declaredState(state) === "autopilot" && !others, waiting: others };
}

export function createAwaiting(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  /** Declared during the current turn, read when it ends. Memory is enough: a turn lives in one process. */
  const declared = new Map<string, { state: DeclaredState; note: string }>();
  // Threads go idle together; one queue for all three maps so a write never
  // replaces another thread's result with a stale copy.
  let lock: Promise<unknown> = Promise.resolve();
  const flag = (key: string) => async (threadId: string, value: boolean) => {
    const run = lock.then(async () => {
      const all = (await kv.get<Record<string, number>>(key)) ?? {};
      if (value === (threadId in all)) return false;
      if (value) all[threadId] = Date.now();
      else delete all[threadId];
      await kv.set(key, all);
      return true;
    });
    lock = run.catch(() => undefined);
    if (await run) changed();
  };
  const get = async () => (await kv.get<Record<string, number>>("awaiting")) ?? {};
  const set = flag("awaiting");
  const getPromised = async () => (await kv.get<Record<string, number>>("promised")) ?? {};
  const setPromised = flag("promised");
  const getWaiting = async () => (await kv.get<Record<string, number>>("waitingOthers")) ?? {};
  // Parked by you: out of every state list until it runs again or you unpark it.
  const getParked = async () => (await kv.get<Record<string, number>>("parked")) ?? {};
  const setParked = flag("parked");
  const setWaiting = flag("waitingOthers");
  const apply = async (threadId: string, flags: { asks: boolean; promised: boolean; waiting: boolean }) => {
    await set(threadId, flags.asks);
    await setPromised(threadId, flags.promised);
    await setWaiting(threadId, flags.waiting);
  };
  // Fallback for turns that ended without a declaration (older sessions,
  // providers without plugin tools): read the last message's wording.
  const classify = (threadId: string, text: string) => apply(threadId, wordingFlags(text));
  /** The agent's own statement for this turn; applied at once and again when the turn ends. */
  const declare = async (threadId: string, state: DeclaredState, note = "") => {
    declared.set(threadId, { state, note });
    await apply(threadId, flagsFor(state, note));
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const text = (await turnReply(bb, thread.id, lastAssistantText)) ?? "";
    const said = declared.get(thread.id);
    declared.delete(thread.id);
    // A report that says nothing is pending wins: the thread is ready, not Needs me.
    const state: DeclaredState | undefined = reportsNothingPending(parseStatusReport(text, Date.now())) ? "ready" : said?.state;
    const flags = state ? flagsFor(state, `${text}\n${said?.note ?? ""}`) : null;
    if (flags) await apply(thread.id, flags);
    else await classify(thread.id, text);
    // A thread you filed under "Waiting for others" goes back to Active once a
    // turn ends without waiting on anyone (it asks you, or it's ready).
    if (flags ? flags.waiting : wordingFlags(text).waiting) return;
    const current = await bb.sdk.threads.get({ threadId: thread.id }).catch(() => null);
    if (current?.sectionId == null) return;
    const { waiting } = await laneSections(bb);
    if (waiting && current.sectionId === waiting) await bb.sdk.threads.update({ threadId: thread.id, sectionId: null });
  });
  const clear = async ({ thread }: { thread: { id: string } }) => {
    declared.delete(thread.id);
    await set(thread.id, false);
    await setPromised(thread.id, false);
    await setWaiting(thread.id, false);
    await setParked(thread.id, false);
  };
  bb.events.on("thread.active", clear);
  bb.events.on("thread.archived", clear);

  // Classify threads that went idle before the plugin was watching.
  bb.background.service("awaiting-backfill", {
    async start(signal) {
      // Bump when the rules change, so open threads are re-classified once.
      if ((await kv.get<number>("awaitingVersion")) !== AWAITING_VERSION) {
        const threads = await bb.sdk.threads.list({ limit: 500 });
        for (const thread of threads) {
          if (signal.aborted) return;
          if (thread.archivedAt !== null || thread.status !== "idle") continue;
          const output = await lastReply(bb, thread.id, signal);
          if (output) await classify(thread.id, output);
        }
        if (!signal.aborted) await kv.set("awaitingVersion", AWAITING_VERSION);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  /** Drops every thread that isn't live any more (archived ones are cleared on archive; this catches deletes). */
  async function prune(isLive: (threadId: string) => boolean) {
    for (const key of ["awaiting", "promised", "waitingOthers"]) {
      const run = lock.then(async () => {
        const all = (await kv.get<Record<string, number>>(key)) ?? {};
        const gone = Object.keys(all).filter((threadId) => !isLive(threadId));
        if (gone.length === 0) return false;
        for (const threadId of gone) delete all[threadId];
        await kv.set(key, all);
        return true;
      });
      lock = run.catch(() => undefined);
      if (await run) changed();
    }
  }

  return { all: get, promised: getPromised, waitingOthers: getWaiting, parked: getParked, park: setParked, prune, declare };
}
