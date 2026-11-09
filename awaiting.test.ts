import assert from "node:assert/strict";
import { test } from "node:test";
import { asksUser, flagsFor, pendsDecision, promisesFollowUp, reportedState, waitsOnOthers, wordingFlags } from "./awaiting.ts";

test("actual questions count as asks", () => {
  assert.ok(asksUser("Want me to open the PR?"));
  assert.ok(asksUser("> **Decision needed:** Which follow-up should this thread start on?\n> 1. A\n> 2. B\n>\n> Reply with the number."));
  assert.ok(asksUser("**Beslutning: hvem skal signere?**\n1. Sander\n2. Patrick"));
  assert.ok(asksUser("Two options are ready. Shall I start the postcode PR?\n\n*2026-10-04*"));
  assert.ok(asksUser("**Your call:** should I send it now?**"));
  assert.ok(asksUser("**Skal Sander betale 10589 på nytt?** Jeg anbefaler ja. Da skriver jeg meldingen."));
});

test("menus, instructions and offers without a question are not asks", () => {
  // The owner only wants real questions in Needs me (2026-11-05).
  assert.ok(!asksUser("Both are ready. Reply **go** for all, or **go 1,3**."));
  assert.ok(!asksUser("- **Your decision:** pick one, and I'll wait for your reply before starting it:\n  1. Move the invoice.\n  2. Publish the report."));
  assert.ok(!asksUser("Merging doesn't ship anything yet.\n\n1. Merge the three PRs now (recommended)\n2. Hold the merge\n3. You review first"));
  assert.ok(!asksUser("If you want, I can snooze this thread for 3 days."));
  assert.ok(!asksUser("Please name the exact Slack channel for the alerts."));
  assert.ok(!asksUser("> 1. Open the other thread and reply there\n>\n> Reply **go** if you want me to sum up its two questions here instead."));
  assert.ok(!asksUser("Draft created in the Amesto thread. It remains unsent."));
});

test("wrapped-up messages don't", () => {
  assert.ok(!asksUser("Merged #9995 into dev and closed T-10600. Everything in this thread is done."));
  assert.ok(!asksUser("All 16 checks passed and the PR is merged."));
  assert.ok(!asksUser("I'm waiting on the fresh review I requested, and will pick it up when it arrives."));
  assert.ok(!asksUser("**Blocked:** Waiting for release (last: v6.100.0)."));
  assert.ok(!asksUser("The prod apply is running in the background. I'll report when it finishes."));
});

test("question marks in code, links and mid-word don't count", () => {
  assert.ok(!asksUser("Opened the run: https://example.com/runs?id=4&tab=logs"));
  assert.ok(!asksUser("**Why does Bob keep starting more?** The dispatcher only checks free slots. The fix is to pause new runs."));
  assert.ok(!asksUser("The filter is `status=open?` in the old code. Fixed and merged."));
  assert.ok(!asksUser("Output:\n```\nContinue? [y/N]\n```\nIt answered no on its own; done."));
});

test("follow-up promises are detected, asks win", () => {
  assert.ok(promisesFollowUp("The prod apply is running in the background: 51,600 documents. I'll report when it finishes."));
  assert.ok(promisesFollowUp("Firebase is still issuing its certificate. I'm checking every 30 seconds for up to 30 minutes and will tell you when it's live."));
  assert.ok(promisesFollowUp("Still waiting on that CI result; will report when it lands."));
  assert.ok(!promisesFollowUp("I'll report when it finishes. Should I also merge #12?"));
  assert.ok(!promisesFollowUp("Merged and deployed. Nothing left to do."));
});

test("waiting on someone else", () => {
  assert.ok(waitsOnOthers("On #1136 and #1137, Alex is now the only pending reviewer. Their approvals are on older commits."));
  assert.ok(waitsOnOthers("The old order stays cancelled.\n\nOnce he sends the invoices, I can check that accounting numbered them."));
  assert.ok(waitsOnOthers("Everything planned for the pilot is done. The next step depends on Sam: which tenant users get access."));
  assert.ok(waitsOnOthers("CI passed. I'm waiting on the fresh review I requested, and will pick it up when it arrives."));
  assert.ok(waitsOnOthers("The two invoices now show as drafts in billing. Chris can push them to accounting from there."));
  assert.ok(waitsOnOthers("I've snoozed this thread until Thursday. When it wakes, I'll check the \"Re: documents\" thread for Sam's reply on two points."));
  assert.ok(waitsOnOthers("When the thread wakes on 12 Oct I'll check for a reply. If Jamie still hasn't answered, I'll draft a nudge for you to review."));
  assert.ok(waitsOnOthers("When the thread wakes, I'll check whether he replied and whether the invoice has been sent."));
  assert.ok(waitsOnOthers("When it wakes, I'll look for Taylor's reply in the thread."));
  assert.ok(waitsOnOthers("Sent the reminder to Morgan on Friday; still no reply from him."));
  assert.ok(!waitsOnOthers("Waiting for CI on #1191; I'll merge when it's green."));
  assert.ok(waitsOnOthers("Once Chris confirms, say \"go\" and I'll switch the setup."), "relaying his answer is waiting on him");
  assert.ok(waitsOnOthers("4. I apply the remaining eight pairs.\n\nTell me when he replies, or paste his answer here."));
  assert.ok(waitsOnOthers("> 1. Rebase the contract.\n> 2. Cancel 11506 if he agrees.\n>\n> Reply **go** with his answer and I'll do both."));
  assert.ok(!waitsOnOthers("Should I merge #12 now?"), "a real ask to you");
  assert.ok(!waitsOnOthers("Merged and deployed. Nothing left to do."));
  assert.ok(!waitsOnOthers("The job is scheduled. It will check the numbers every night."));
});

test("sign-offs, summaries and other people's steps aren't asks", () => {
  assert.ok(!asksUser("Done. PR #42 is merged and deployed. Let me know if you need anything else."));
  assert.ok(!asksUser("Fixed. Please note the migration takes ~3 minutes on prod."));
  assert.ok(!asksUser("Summary of changes:\n\n1. Renamed the config loader\n2. Added tests for it\n3. Updated the README"));
  assert.ok(waitsOnOthers("The PR is up. Sam needs to approve it before I can merge."));
  assert.ok(!waitsOnOthers("Pushed the fix. Waiting for the pipeline to go green."));
  assert.ok(!waitsOnOthers("Waiting for the tests to finish before merging."));
  assert.ok(promisesFollowUp("I’ll report back when the build finishes."));
});

test("questions asked with inline UI controls count as asks", () => {
  const ui = (body: string, after = "") => `Here is where things stand.\n\`\`\`ui\n${body}\n\`\`\`\n${after}`;
  assert.ok(asksUser(ui('Card("Add a watch?", [Button("Yes, build it"), Button("No, leave it")])', "Nothing else changed.")));
  assert.ok(asksUser(ui('$x = ""\nCard("Before I plan", [Form([Radio($x, ["A", "B"], label: "Which?")])])')));
  assert.ok(asksUser(ui('Card("Plan", [Plan([{title: "Do X"}])])')));
  assert.ok(asksUser(ui('Card("Pick", [Decision([{name: "A", scores: [1]}], ["Speed"])])')));
  assert.ok(asksUser(ui('Card("Delete?", [Button("Delete it", variant: "destructive")])')));
});

test("inline UI without a question is not an ask", () => {
  const ui = (body: string) => `All green.\n\`\`\`ui\n${body}\n\`\`\`\nShipped.`;
  assert.ok(!asksUser(ui('Card("Next", [FollowUps(["Ship it?", "Write the docs?"])])')));
  assert.ok(!asksUser(ui('Card("Links", [Button("Open the run", OpenUrl("https://example.com"))])')));
  assert.ok(!asksUser(ui('Card("Done", [Metric("Tests", "97 passed")])')));
});

test("a labelled decision question counts even when evidence follows it", () => {
  const evidence = "\n\n" + "The details: the queue was busy for four days and the memory peaked near the limit. ".repeat(20);
  assert.ok(asksUser("Findings are in.\n\n**Your decision:** how should the bot get more capacity?\n1. Run it ourselves\n2. Pay for more" + evidence));
  assert.ok(asksUser("Status.\n\n**Din beslutning:** hvem skal ta oppgaven?" + evidence));
  assert.ok(!asksUser("Findings are in.\n\n**Your decision:** pick one, and I'll start on it." + evidence));
});

test("Norwegian promises to report back count", () => {
  assert.ok(promisesFollowUp("Branchen lå bak main, så jeg har oppdatert den. Ny kjøring går nå, og jeg får beskjed når den er ferdig.\n\nNår den er grønn, merger jeg og følger med på deployen."));
  assert.ok(promisesFollowUp("Deployen kjører. Jeg melder fra så snart den er ute."));
  assert.ok(promisesFollowUp("Apply og deploy går nå. Jeg følger begge i bakgrunnen og sier fra når de er ferdige."));
  assert.ok(!promisesFollowUp("Alt er merget og ute i produksjon."));
});

test("a declared state sets exactly one flag, and done clears them all", () => {
  assert.deepEqual(flagsFor("needs_you"), { asks: true, promised: false, waiting: false });
  assert.deepEqual(flagsFor("will_report_back"), { asks: false, promised: true, waiting: false });
  assert.deepEqual(flagsFor("waiting_on_others"), { asks: false, promised: false, waiting: true });
  assert.deepEqual(flagsFor("done"), { asks: false, promised: false, waiting: false });
});

// Real last messages from threads that were wrongly shown as Autopilot (9 Nov 2026).
const state = (text: string) => {
  const flags = wordingFlags(text);
  return flags.asks ? "needs" : flags.promised || flags.waiting ? "autopilot" : "ready";
};

test("a blocker only you can clear is Needs me, never Autopilot", () => {
  assert.equal(state("**BLOCKED:** B448 mangler tilgang til tilbudslenken i prod. Jeg kan ikke gå videre før du gir tilgang."), "needs");
  assert.equal(state("SHIPIT-BLOCKED: the premerge gate needs your approval."), "needs");
  assert.deepEqual(flagsFor("autopilot", "FOLLOW_UP_REQUIRED: Bob needs a maintenance grant."), { asks: true, promised: false, waiting: false });
});

test("asks without a question mark are Needs me", () => {
  assert.equal(state("- **#6335**, the Portal demo security fix, waits for your answer: ship it now or switch Comms."), "needs");
  assert.equal(state("No new action. The follow-up options above are still waiting for your reply."), "needs");
  assert.equal(state("**Who owns each step:**\n1. **You:** approve the draft.\n2. **Me:** send it.\n3. **Jan:** send the credit note."), "needs");
});

test("a sign-off that waits for your next message is Ready, not waiting on someone else", () => {
  assert.equal(waitsOnOthers("Nothing needs approval. Waiting for your next message."), false);
  assert.equal(state("Nothing needs approval. Waiting for your next message."), "ready");
  assert.equal(state("I'll wait for your next message."), "ready");
});

test("work that carries on by itself is Autopilot", () => {
  assert.equal(state("A background job will wait for the merge, then follow the Terraform apply. I'll check the file and the next morning line then."), "autopilot");
  assert.equal(state("**What happens next.** The planning thread's daily 10:00 recheck will confirm the fixes from PostHog events after the deploy."), "autopilot");
});

test("the report's State line and a nothing-pending report decide the state", () => {
  assert.equal(reportedState("**Goal:** x\n**State:** Needs me — pick a plan"), "needs_you");
  assert.equal(reportedState("**State:** Autopilot (CI running)"), "autopilot");
  assert.equal(reportedState("**State:** Running"), undefined);
  assert.equal(state("**Goal:** ship it\n**Done:** merged\n**State:** Ready\nAnything else?"), "ready");
});

// A decision left open is Needs me, even when the agent said Ready (Errors W2, 9 Nov 2026).
test("an open decision is Needs me whatever state the agent declared", () => {
  const w2 = "**Goal:** Fewer browser errors\n\n**Done:** The fix went live.\n\n**Next:** Look again after a full day.\n\n**State:** Ready\n\n### Next steps\n> [!TIP]\n> **Decision needed:** You have two open choices. Answer either one:\n>   1. Keep that page · simplest (recommended)\n>   2. Send the customer to the newest offer\n>\n> Reply with the numbers.";
  assert.ok(pendsDecision(w2));
  assert.equal(state(w2), "needs");
  assert.deepEqual(flagsFor("done", w2), { asks: true, promised: false, waiting: false });
  assert.deepEqual(flagsFor("autopilot", w2), { asks: true, promised: false, waiting: false });
  assert.equal(state("- **Your decision:** pick one, and I'll wait for your reply before starting it:\n  1. Move the invoice.\n  2. Publish the report."), "needs");
  assert.equal(state("Still open: the four partners wait for your decision on whether a factoring company's account may be confirmed."), "needs");
  assert.equal(state("Next: review the compact mockup and decide whether to implement it."), "needs");
});

test("an optional offer in a report that says nothing is pending stays Ready", () => {
  assert.ok(!pendsDecision("If you'd rather a claim cover only its issues, that's your call.\n\nNothing else is pending, so this thread can be archived."));
  assert.ok(!pendsDecision("**Goal:** Ship\n\n**Done:** Built\n\n**Next:** Nothing pending.\n\n### Next steps\n> **Path forward:** Optional\n> 1. Tidy up · nice\n>\n> Reply **go** for all."));
  assert.equal(state("Nothing needs approval. Waiting for your next message."), "ready");
});
