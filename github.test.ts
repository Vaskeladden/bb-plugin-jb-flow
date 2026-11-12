import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createGitHub, createQuota, pausedText, QUOTA_FLOOR, QuotaPausedError, RateLimitedError, type Runner } from "./github.ts";

// One owner: only github.ts may start gh or talk to the GitHub API. Every
// source file in the tree is read (tests and dependencies aside). A process
// can only be started through node:child_process (or a wrapper such as execa
// or zx), so only the files that run git may import it, and none of them may
// name gh.
const PROCESS_OWNERS = new Set(["github.ts", "git-clean.ts", "leftovers.ts"]);
const SPAWNERS = [/["'`](node:)?child_process["'`]/, /["'`]execa["'`]/, /["'`]zx["'`]/, /\bBun\.spawn/, /\bDeno\.Command/, /process\.binding\(/];
const NAMES_GH = [
  /["'`]gh["'`]/, // "gh" as a command or a variable's value
  /\/bin\/gh\b/,
  /["'`]gh\s+(api|pr|run|repo|issue|release|search|auth|workflow)\b/, // a shell string
  /\bgh(Bin|Path|Binary|Command|Cmd)\b/i,
];
const GITHUB_API = [/api\.github\.com/, /["'`]api["'`],\s*["'`]graphql["'`]/, /\bOctokit\b/, /@octokit\//];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ["node_modules", "dist", ".git", ".bb-plugin"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs|jsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("no file but github.ts starts gh or calls the GitHub API", () => {
  const files = sourceFiles(".");
  assert.ok(files.includes("github.ts") && files.some((file) => file.startsWith("components/")), "walks the whole tree");
  const offenders = files.flatMap((file) => {
    if (file === "github.ts") return [];
    const text = readFileSync(file, "utf8");
    const code = text.replace(/^\s*\/\/.*$/gm, ""); // comments may mention gh
    const found: string[] = [];
    if (!PROCESS_OWNERS.has(file)) found.push(...SPAWNERS.filter((pattern) => pattern.test(code)).map((pattern) => `${file}: starts processes (${pattern})`));
    // Messages to agents may quote gh commands; files that can start a process may not.
    if (PROCESS_OWNERS.has(file)) found.push(...NAMES_GH.filter((pattern) => pattern.test(code)).map((pattern) => `${file}: names gh (${pattern})`));
    found.push(...GITHUB_API.filter((pattern) => pattern.test(code)).map((pattern) => `${file}: GitHub API (${pattern})`));
    return found;
  });
  assert.deepEqual(offenders, []);
});

test("the owner test catches every way of starting gh", () => {
  const caught = (file: string, code: string) =>
    (!PROCESS_OWNERS.has(file) && SPAWNERS.some((pattern) => pattern.test(code))) || (PROCESS_OWNERS.has(file) && NAMES_GH.some((pattern) => pattern.test(code))) || GITHUB_API.some((pattern) => pattern.test(code));
  assert.equal(caught("prs.ts", `import { spawnSync } from "node:child_process"; spawnSync(bin, args);`), true);
  assert.equal(caught("prs.ts", `const { exec } = require("child_process");`), true);
  assert.equal(caught("prs.ts", `import { execa } from "execa";`), true);
  assert.equal(caught("leftovers.ts", `const tool = "gh"; execFile(tool, ["pr", "list"]);`), true);
  assert.equal(caught("leftovers.ts", "exec(`gh pr list -R ${repo}`);"), true);
  assert.equal(caught("leftovers.ts", `execFile("/opt/homebrew/bin/gh", args);`), true);
  assert.equal(caught("components/x.tsx", `fetch("https://api.github.com/repos/a/b")`), true);
  // Quoting a command to an agent is fine outside the process owners.
  assert.equal(caught("server.ts", "Use this instead of `gh pr view`."), false);
});

test("each resetAt is its own counter, and the lowest live one decides", () => {
  let now = Date.parse("2026-11-11T11:30:00Z");
  const quota = createQuota(() => now);
  quota.record(4000, Date.parse("2026-11-11T12:21:08Z"));
  quota.record(QUOTA_FLOOR - 1, Date.parse("2026-11-11T11:33:25Z"));
  const state = quota.state();
  assert.equal(state.paused, true);
  assert.equal(state.paused && state.resumesAt, Date.parse("2026-11-11T11:33:25Z"));
  assert.match(pausedText(state) ?? "", /^Paused: GitHub quota low, resumes \d\d:\d\d$/);
  // That counter resets: reading resumes, the other counter is still fine.
  now = Date.parse("2026-11-11T11:33:30Z");
  assert.deepEqual(quota.state(), { paused: false });
  assert.equal(quota.readings().length, 1);
});

test("a newer reading of the same counter only lowers remaining", () => {
  const now = Date.parse("2026-11-11T11:30:00Z");
  const quota = createQuota(() => now);
  const reset = Date.parse("2026-11-11T12:00:00Z");
  quota.record(900, reset);
  quota.record(4000, reset); // an answer from another node, older or rounder: not trusted upwards
  assert.equal(quota.state().paused, true);
});

test("a rate-limit refusal pauses every read and is not retried", async () => {
  let calls = 0;
  const runner: Runner = async (args) => {
    calls += 1;
    if (args[1] === "rate_limit") return { stdout: "[1794400000, 1794401000]", stderr: "", error: null };
    return { stdout: "", stderr: "GraphQL: API rate limit already exceeded for user ID 1.", error: Object.assign(new Error("exit 1"), { code: 1 }) };
  };
  const github = createGitHub(createQuota(), runner);
  await assert.rejects(github.graphql("query { rateLimit { remaining resetAt } }", "PRs"), RateLimitedError);
  assert.equal(calls, 2); // the query once, then the free GET /rate_limit for the reset time
  await assert.rejects(github.graphql("query { viewer { login } }", "PRs"), QuotaPausedError);
  await assert.rejects(github.gh(["api", "user"], "the user"), QuotaPausedError);
  assert.equal(calls, 2);
  assert.equal(github.quota.state().paused, true);
});

test("a GraphQL answer below the floor pauses the next read", async () => {
  const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
  let calls = 0;
  const runner: Runner = async () => {
    calls += 1;
    return { stdout: JSON.stringify({ data: { rateLimit: { remaining: 400, resetAt } } }), stderr: "", error: null };
  };
  const github = createGitHub(createQuota(), runner);
  await github.graphql("query { rateLimit { remaining resetAt } }", "PRs");
  await assert.rejects(github.graphql("query { rateLimit { remaining resetAt } }", "PRs"), QuotaPausedError);
  assert.equal(calls, 1);
});

test("partial GraphQL answers keep their data", async () => {
  const runner: Runner = async () => ({
    stdout: JSON.stringify({ data: { r0: { p1: null, p2: { number: 2 } } }, errors: [{ message: "Could not resolve to a PullRequest with the number of 1." }] }),
    stderr: "",
    error: Object.assign(new Error("exit 1"), { code: 1 }),
  });
  const { data, errors } = await createGitHub(createQuota(), runner).graphql<{ r0: Record<string, unknown> }>("query { x }", "PRs");
  assert.deepEqual(data.r0.p2, { number: 2 });
  assert.equal(errors.length, 1);
});
