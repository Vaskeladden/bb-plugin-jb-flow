import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantMessages, isSignOff, withEarlierReply } from "./turn-reply.ts";

// The Donkey turn in "Main is red" (9 Nov 2026): the report with two decisions,
// then thread_state, then a one-line sign-off that hid the question box.
const report = "**Goal:** Every fix should reach customers quickly.\n\n**Blocked:** Flaky checks.\n\n### Next steps\n> [!TIP]\n> **Decision needed:** How should we stop the notification test failing?\n> 1. Warm up the browser (recommended)\n> 2. Leave it\n>\n> Reply with the number.";
const signOff = "I've stopped here and am waiting for your two answers.";
const timeline = { rows: [{ kind: "turn", turnId: "t1", rows: [
  { role: "assistant", turnId: "t1", messageSeq: 10, text: "Checking the runs." },
  { role: "assistant", turnId: "t1", messageSeq: 20, text: report },
  { role: "assistant", turnId: "t1", messageSeq: 30, text: signOff },
] }] };

test("a sign-off after the report is read together with the report", () => {
  assert.ok(isSignOff(signOff));
  assert.ok(!isSignOff(report));
  const messages = assistantMessages(timeline);
  assert.deepEqual(messages.map((message) => message.seq), [10, 20, 30]);
  assert.equal(withEarlierReply(messages, signOff), `${report}\n\n${signOff}`);
});

test("a full last reply, or a report from an earlier turn, is left alone", () => {
  const messages = assistantMessages(timeline);
  assert.equal(withEarlierReply(messages, report), report);
  const nextTurn = [...messages.map((message) => ({ ...message, turnId: "t1" })), { turnId: "t2", seq: 40, text: "Done." }];
  assert.equal(withEarlierReply(nextTurn, "Done."), "Done.");
});
