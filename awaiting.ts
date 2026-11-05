// Classifies an idle thread's final agent message: did it end by handing the
// next move to the user (a question, options to pick, a decision board, "reply
// go"), or is the work wrapped up? Read-but-unanswered asks otherwise look
// like finished threads ("Done") even though the agent is waiting on you.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseDecisionOptions } from "./decisions.ts";
import { laneSections } from "./lanes.ts";

// Phrases that hand the next step to the user. Kept specific: status reports
// mention "decision" or "blocked" without waiting on anyone.
const ASKS = new RegExp(
  [
    String.raw`\?\s*$`,
    String.raw`\b(reply|answer|write|type|send)\s+["“*]{0,2}(go|yes)\b`,
    String.raw`\bsay\s+["“*]{1,2}(go|yes)\b`, // quoted: "if they say yes" is about someone else
    String.raw`\b(want me to|should i|shall i|would you like|do you want|if you('d)? (want|like|prefer))\b`,
    String.raw`\bif you (place|send|run|give|share|paste|confirm|approve|sign)\b`,
    String.raw`\b(can|could|would) you\b`,
    // Sign-offs ("Let me know if you need anything else", "Please note…") aren't asks.
    String.raw`\blet me know\b(?!\s+if (you )?(need|have|want anything|there's anything|anything|something))`,
    String.raw`\btell me\b`,
    String.raw`\bplease\b(?!\s+(note|be aware|keep in mind|feel free|ignore))`,
    String.raw`\byour (call|decision|input|answer|go-ahead)\b`,
    String.raw`\bdecisions? (needed|for you|board)\b`,
    // Addressed to you only: "Sam needs to approve it" waits on Sam.
    String.raw`\byou (decide|choose|approve)\b|\bpick (one|an option|between|which|a|the)\b(?! up)`,
    String.raw`\bpaste (it|the text|them|his|her|their)\b`,
    String.raw`\b(waiting|blocked) (for|on|until) you\b`,
    String.raw`\bonce you('ve| have)?\b`,
    String.raw`\byou('ll)? need to\b`,
    String.raw`\bneeds? (you|your)\b`,
    String.raw`\b(you send it|unsent|in your drafts)\b`,
    String.raw`\bnext step:?\**\s*(send|sign|install|reply|review|approve|run)\b`,
  ].join("|"),
  "i",
);

const AWAITING_VERSION = 12;

/** True when the tail of the message hands the next step to the user. */
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

export function asksUser(text: string): boolean {
  text = straight(text);
  if (asksWithControls(text)) return true;
  // Conditional fallbacks ("If it still breaks, tell me what you did") aren't
  // asks; conditions addressed to you ("If you want, I can…") still are.
  const tail = text
    .trim()
    .slice(-900)
    .replace(/(^|[.!?\n]\s*)if (?!you\b)(?:[^.!?\n]|[.!?](?=\S))*[.!?]?/gi, "$1");
  // Trailing numbered options are a choice for you, whatever the wording.
  // Any trailing numbered list counts here: a to-do list for you is an ask too.
  return ASKS.test(tail) || parseDecisionOptions(text, { strict: false }).length > 0;
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

export function createAwaiting(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
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
  const classify = async (threadId: string, text: string) => {
    await set(threadId, asksUser(text) && !relaysOthers(text));
    await setPromised(threadId, promisesFollowUp(text));
    await setWaiting(threadId, waitsOnOthers(text));
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const text = lastAssistantText ?? "";
    await classify(thread.id, text);
    // A thread you filed under "Waiting for others" goes back to Active once a
    // turn ends without waiting on anyone (it asks you, or it's done).
    if (waitsOnOthers(text)) return;
    const current = await bb.sdk.threads.get({ threadId: thread.id }).catch(() => null);
    if (current?.sectionId == null) return;
    const { waiting } = await laneSections(bb);
    if (waiting && current.sectionId === waiting) await bb.sdk.threads.update({ threadId: thread.id, sectionId: null });
  });
  const clear = async ({ thread }: { thread: { id: string } }) => {
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

  return { all: get, promised: getPromised, waitingOthers: getWaiting, prune };
}
