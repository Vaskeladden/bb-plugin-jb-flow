// Classifies an idle thread's final agent message: did it end with an actual
// question to the user (a sentence ending in "?", or inline answer controls),
// or is the work wrapped up? Menus of next steps ("pick one", "Reply go for
// all") are not questions; the owner only wants real questions in Needs me.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneSections } from "./lanes.ts";

const AWAITING_VERSION = 15;

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
  return QUESTION.test(prose.slice(-900)) || DECISION_QUESTION.test(prose);
}

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
    String.raw`\b([Ww]aiting|[Ww]ait) (for|on) (?![Yy]ou\b|CI\b|ci\b|(the|that) CI\b|[Cc]hecks?\b|(the|that|it|a|its|all) (CI|build|deploy|release|certificate|run|job|result|pipeline|tests?|workflows?|suite|checks?|migration|merge|GitHub Actions)\b|release\b|deploy\b|pipeline\b|tests?\b|workflows?\b|GitHub Actions\b|[Aa]ctions\b)\w`,
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

/** A promise counts as stalled after the thread has been idle this long. */
export const STALLED_AFTER_MS = 60 * 60_000;

/** What the agent says the thread waits for when its turn ends (the `thread_state` tool). */
export const DECLARED_STATES = ["needs_you", "will_report_back", "waiting_on_others", "done"] as const;
export type DeclaredState = (typeof DECLARED_STATES)[number];

/** The three flags a declared state sets; the agent's own words beat any pattern. */
export function flagsFor(state: DeclaredState): { asks: boolean; promised: boolean; waiting: boolean } {
  return { asks: state === "needs_you", promised: state === "will_report_back", waiting: state === "waiting_on_others" };
}

export function createAwaiting(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  /** Declared during the current turn, read when it ends. Memory is enough: a turn lives in one process. */
  const declared = new Map<string, DeclaredState>();
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
  const setWaiting = flag("waitingOthers");
  const apply = async (threadId: string, flags: { asks: boolean; promised: boolean; waiting: boolean }) => {
    await set(threadId, flags.asks);
    await setPromised(threadId, flags.promised);
    await setWaiting(threadId, flags.waiting);
  };
  // Fallback for turns that ended without a declaration (older sessions,
  // providers without plugin tools): read the last message's wording.
  const classify = (threadId: string, text: string) =>
    apply(threadId, {
      asks: asksUser(text) && !relaysOthers(text),
      promised: promisesFollowUp(text),
      waiting: waitsOnOthers(text),
    });
  /** The agent's own statement for this turn; applied at once and again when the turn ends. */
  const declare = async (threadId: string, state: DeclaredState) => {
    declared.set(threadId, state);
    await apply(threadId, flagsFor(state));
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const text = lastAssistantText ?? "";
    const state = declared.get(thread.id);
    declared.delete(thread.id);
    if (state) await apply(thread.id, flagsFor(state));
    else await classify(thread.id, text);
    // A thread you filed under "Waiting for others" goes back to Active once a
    // turn ends without waiting on anyone (it asks you, or it's done).
    if (state ? state === "waiting_on_others" : waitsOnOthers(text)) return;
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
          if (thread.archivedAt !== null || thread.status !== "idle" || thread.parentThreadId !== null) continue;
          const output = await bb.sdk.threads.output({ threadId: thread.id, signal }).catch(() => null);
          if (output?.output) await classify(thread.id, output.output);
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

  return { all: get, promised: getPromised, waitingOthers: getWaiting, prune, declare };
}
