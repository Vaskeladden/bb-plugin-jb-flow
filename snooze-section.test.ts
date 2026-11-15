import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionOnWake, sectionSnoozedFrom } from "./snooze-section.ts";

const SNOOZED = "sec_snoozed";

test("a snoozed thread remembers the section it was in", () => {
  assert.equal(sectionSnoozedFrom(undefined, "sec_infra", SNOOZED), "sec_infra");
  assert.equal(sectionSnoozedFrom(undefined, null, SNOOZED), null);
});

test("snoozing it again keeps the first section, not Snoozed", () => {
  assert.equal(sectionSnoozedFrom("sec_infra", SNOOZED, SNOOZED), "sec_infra");
  // Moved by hand while snoozed, then snoozed again: still the section it first came from.
  assert.equal(sectionSnoozedFrom("sec_infra", "sec_research", SNOOZED), "sec_infra");
});

test("a thread found in Snoozed without a record never names Snoozed as its home", () => {
  assert.equal(sectionSnoozedFrom(undefined, SNOOZED, SNOOZED), null);
  assert.equal(sectionSnoozedFrom(null, SNOOZED, SNOOZED), null);
});

test("waking puts it back in that section, or in Unassigned when the section is gone", () => {
  assert.equal(sectionOnWake("sec_infra", ["sec_research", "sec_infra", SNOOZED]), "sec_infra");
  assert.equal(sectionOnWake("sec_deleted", ["sec_research", SNOOZED]), null);
  assert.equal(sectionOnWake(null, ["sec_research", SNOOZED]), null);
});

test("snooze, snooze again, wake: back where it started", () => {
  const first = sectionSnoozedFrom(undefined, "sec_infra", SNOOZED);
  const second = sectionSnoozedFrom(first, SNOOZED, SNOOZED);
  assert.equal(sectionOnWake(second, ["sec_infra", SNOOZED]), "sec_infra");
});
