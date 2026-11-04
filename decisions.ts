// Finds the numbered options an agent ends its message with ("1. … 2. …"),
// so the composer can offer them as one-click replies.
import { parseStatusReport } from "./thread-status.ts";

export type DecisionOption = { n: number; text: string; recommended: boolean };
/** "go": steps to run, answered with "go" or "go 1,3". "choice": answered with one number. */
export type DecisionMode = "go" | "choice";

const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Words in the line before a list that make it a choice for the user.
const CHOICE_INTRO =
  /\?\s*\**\s*$|\b(options?|alternatives?|choose|choices?|pick|which|prefer|either|decide|decision|want me to|should (i|we)|shall (i|we)|how (should|do) (i|we)|what (should|do) (i|we)|reply|recommended|your call|ways? (forward|to)|approaches|paths?)\b/i;
// "Reply go for all, or go 1,3", "Reply `go` for the next slice": the list is answered with go.
const GO_REPLY = /\b(reply|say|write|type|send)\s+[*_`"“']*go\b|\bgo[*_`]*\s+(for all|\d)/i;
// Text after a list that asks for one of its numbers.
const CHOICE_OUTRO =
  /\b(reply|answer|respond|write|type|say|send)\b[^.\n]{0,40}\b(number|option|one of)\b|\bpick (one|a number|an option)\b|\bwhich (one|option)\b|\bgo\**\s+(for all|\d)/i;

/** The numbered list a message ends with, the line before it and the text after it. */
function trailingList(message: string): { options: DecisionOption[]; intro: string; outro: string } | null {
  const lines = message.trim().split("\n").slice(-30);
  // Walk up from the end, skipping trailing chatter (timestamps, "Reply with the number").
  let end = lines.length - 1;
  while (end >= 0 && !/^\s*(?:>\s*)*\d+[.)]\s+\S/.test(lines[end]!)) {
    if (lines.length - 1 - end > 6) return null;
    end -= 1;
  }
  const options: DecisionOption[] = [];
  let first = end;
  for (let index = end; index >= 0; index -= 1) {
    const match = /^\s*(?:>\s*)*(\d+)[.)]\s+(.+)$/.exec(lines[index]!);
    if (!match) {
      if (/^\s*(?:>\s*)*$/.test(lines[index]!) && options.length === 0) continue;
      break;
    }
    const raw = match[2]!;
    first = index;
    options.unshift({
      n: Number(match[1]),
      text: plain(raw.replace(/\(recommended\)/i, "")).slice(0, 500),
      recommended: /\(recommended\)|\brecommended\b/i.test(raw),
    });
  }
  const intro = lines.slice(0, first).reverse().find((line) => line.trim() !== "" && !/^\s*(?:>\s*)*$/.test(line)) ?? "";
  return { options, intro, outro: lines.slice(end + 1).join("\n") };
}

/** A trailing list's intro as the box shows it: a marker or a "Recommended" line is not a question. */
function questionFromIntro(intro: string): string {
  const text = intro.replace(/^\s*(?:>\s*)*/, "");
  if (/^\[!\w+\]|^\*\*Recommended/i.test(text)) return "";
  return plain(text.replace(/\*\*(Decision needed|Path forward):\*\*/i, "")).slice(0, 300);
}

/**
 * Numbered options the user can pick from, for one-click replies. A numbered
 * list is only a choice when something says so: an option marked recommended,
 * an intro that asks or offers, or a closing line asking for a number. With
 * `{ strict: false }` any trailing list counts (the "does this need me" check,
 * where a to-do list for the user is also an ask).
 */
export function parseDecisionOptions(message: string, { strict = true }: { strict?: boolean } = {}): DecisionOption[] {
  const list = trailingList(message);
  if (!list) return [];
  const { options, intro, outro } = list;
  // "When it's green, I'll: 1. Merge 2. Release" is the agent's own plan, not a choice.
  if (/\bI('ll| will|'m going to)\b[^?]*:\s*\**\s*$/i.test(intro) && !options.some((option) => option.recommended)) return [];
  // "Summary of changes: 1. Renamed… 2. Added…" reports what happened.
  const recommended = options.some((option) => option.recommended);
  const summaryIntro = /\b(summary|changes|changed|what (i|we) did|completed|fixed|shipped|included)\b[^?]*:\s*\**\s*$/i.test(intro);
  const pastTense = options.every(
    (option) => /^(?!(need|feed|seed|speed|proceed|succeed|exceed)\b)(\w{3,}ed|built|wrote|made|ran|set|kept|put|left|found|took|got|sent|split|cut)\b/i.test(option.text),
  );
  if ((summaryIntro || pastTense) && !recommended) return [];
  // A real choice: 2–9 consecutive options numbered from 1.
  if (options.length < 2 || options.length > 9 || options[0]!.n !== 1) return [];
  if (options.some((option, index) => option.n !== index + 1)) return [];
  // "Manual fallback: 1. Finance verifies… 2. …" describes steps; no buttons.
  if (strict && !recommended && !CHOICE_INTRO.test(intro) && !CHOICE_OUTRO.test(outro)) return [];
  return options;
}

/** One group of options in "Your next move": a go-list or a decision. */
export type DecisionGroup = { mode: DecisionMode; question: string; options: DecisionOption[] };

/**
 * What "Your next move" offers for a thread's last reply: a status report's
 * groups of next steps (a go-list, a decision, or one of each), or else a
 * trailing numbered choice, and whether each is answered with "go" or a number.
 */
export function nextMove(message: string): { groups: DecisionGroup[] } {
  const groups = parseStatusReport(message, 0)?.stepGroups ?? [];
  if (groups.length) {
    return {
      groups: groups.map((group) => ({
        mode: group.mode,
        question: group.question,
        options: group.items.map((text, index) => ({ n: index + 1, text, recommended: group.recommended.includes(index + 1) })),
      })),
    };
  }
  const options = parseDecisionOptions(message);
  if (!options.length) return { groups: [] };
  const tail = message.trim().split("\n").slice(-30).join("\n");
  return { groups: [{ mode: GO_REPLY.test(tail) ? "go" : "choice", question: questionFromIntro(trailingList(message)?.intro ?? ""), options }] };
}
