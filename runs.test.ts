import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunRef, runOutcome } from "./runs.ts";

test("a run is named by id, owner/name#id or URL", () => {
  assert.deepEqual(parseRunRef("https://github.com/acme/web-app/actions/runs/123/job/9", null), { repo: "acme/web-app", runId: 123 });
  assert.deepEqual(parseRunRef("acme/billing-api#45", null), { repo: "acme/billing-api", runId: 45 });
  assert.deepEqual(parseRunRef(678, "acme/web-app"), { repo: "acme/web-app", runId: 678 });
  assert.throws(() => parseRunRef("678", null), /no GitHub remote/);
  assert.throws(() => parseRunRef("deploy", "acme/web-app"), /not a run id/);
});

test("a running run says nothing", () => {
  assert.equal(runOutcome({ status: "in_progress", conclusion: null, name: "Deploy", url: "u" }, "acme/web-app"), null);
  assert.equal(runOutcome({ status: "queued", conclusion: null, name: "Deploy", url: "u" }, "acme/web-app"), null);
});

test("a finished run reports its result and the jobs that failed", () => {
  const ok = runOutcome({ status: "completed", conclusion: "success", name: "Deploy", url: "u" }, "acme/web-app");
  assert.deepEqual(ok, { failed: false, text: "✅ web-app · Deploy finished: success. u" });
  const bad = runOutcome(
    {
      status: "completed",
      conclusion: "failure",
      name: "Deploy",
      displayTitle: "fix: x",
      url: "u",
      jobs: [
        { name: "build", conclusion: "success" },
        { name: "apply", conclusion: "failure" },
        { name: "notify", conclusion: "skipped" },
      ],
    },
    "acme/web-app",
  );
  assert.equal(bad?.failed, true);
  assert.equal(bad?.text, "❌ web-app · Deploy (fix: x) finished: failure. Failed: apply. u");
});
