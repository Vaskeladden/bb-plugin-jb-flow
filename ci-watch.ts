// What one CI watch (`wait_for_ci`) says after a hub read of its PR. Pure, so
// every rule is tested in ci-watch.test.ts; watchers.ts sends the notes.
import { verdictText, type FailedCheck, type PrLight, type Verdict } from "./hub-model.ts";

export const CI_TIMEOUT_MS = 3 * 3_600_000;
export const NO_CHECKS_AFTER_MS = 10 * 60_000;

/** Deploy-preview and housekeeping bots: their comments are not review feedback. */
const BOT_LOGINS = new Set(["vercel", "github-actions", "dependabot", "linear", "changeset-bot", "codecov", "netlify", "sonarcloud"]);
export const isBot = (login: string | null | undefined, body: string) =>
  login === undefined || login === null || login.endsWith("[bot]") || BOT_LOGINS.has(login) || /^\[vc\]:/.test(body);

export type CiWatch = {
  threadId: string;
  repo: string;
  pr: number;
  watchFor: "checks" | "reviews" | "both";
  since: number;
  /** Reviews/comments newer than this are reported; advances after each report. */
  reviewsSince?: number;
  headSha: string | null;
  /** "both" after its checks were reported: keep listening for reviews, end silently. */
  quiet?: boolean;
};

export type CiStep = {
  notes: string[];
  /** The watch ends. */
  done: boolean;
  /** Something to tell the thread (or a silent end). */
  report: boolean;
  /** The failed check whose log should follow the notes. */
  logOf: FailedCheck | null;
  /** The watch after this read (since, head, mode, review cursor). */
  watch: CiWatch;
};

const short = (repo: string) => repo.split("/")[1];
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One read of a watched PR: what to say, and what the watch becomes. */
export function stepCiWatch(input: CiWatch, light: PrLight, verdict: Verdict, me: string | null, now: number): CiStep {
  const watch: CiWatch = { ...input };
  const notes: string[] = [];
  let done = false;
  let checksReported = false;
  let logOf: FailedCheck | null = null;

  if (light.state !== "OPEN") {
    notes.push(`PR ${short(watch.repo)}#${watch.pr} is now ${light.state.toLowerCase()}.`);
    done = true;
  }
  // A new push restarts the checks; keep waiting on the new head.
  if (watch.headSha !== null && watch.headSha !== light.headSha) watch.since = now;
  watch.headSha = light.headSha;

  if (!done && watch.watchFor !== "reviews") {
    let concluded = false;
    if (verdict.kind === "green" || verdict.kind === "failed") {
      notes.push(verdictText(light, verdict));
      if (verdict.kind === "failed") logOf = verdict.blocking.find((check) => check.url) ?? null;
      concluded = true;
    } else if (verdict.kind === "none" && now - watch.since > NO_CHECKS_AFTER_MS) {
      notes.push(`${short(watch.repo)}#${watch.pr} has no CI checks after 10 minutes; nothing to wait for.`);
      concluded = true;
    }
    if (concluded) {
      // "both" keeps listening for reviews (review bots often answer after CI).
      if (watch.watchFor === "both") {
        watch.watchFor = "reviews";
        watch.quiet = true;
        checksReported = true;
      } else done = true;
    }
  }

  let reviewNews = false;
  if (watch.watchFor !== "checks" && light.feedback) {
    const cutoff = watch.reviewsSince ?? watch.since;
    const human = (author: string | null, body: string) => author !== me && !isBot(author, body);
    const reviews = light.feedback.reviews.filter((review) => review.at > cutoff && human(review.author, review.body));
    const comments = light.feedback.comments.filter((comment) => comment.at > cutoff && human(comment.author, comment.body));
    for (const review of reviews) notes.push(`Review from ${review.author ?? "someone"}: ${review.state}${review.body ? ` — ${truncate(review.body, 800)}` : ""}`);
    for (const comment of comments) notes.push(`Comment from ${comment.author ?? "someone"}: ${truncate(comment.body, 800)}`);
    if (reviews.length + comments.length > 0) {
      reviewNews = true;
      notes.push(`Full comments: \`gh pr view ${watch.pr} -R ${watch.repo} --comments\`; inline: \`gh api repos/${watch.repo}/pulls/${watch.pr}/comments\``);
      // Reviews only: done. Both: report now, keep watching the checks.
      if (watch.watchFor === "reviews") done = true;
    }
  }

  if (!done && now - watch.since > CI_TIMEOUT_MS) {
    // A quiet review watch already told the agent about its checks.
    if (!watch.quiet) notes.push(`Still waiting on ${short(watch.repo)}#${watch.pr} after 3 hours; stopped watching. ${light.url}`);
    done = true;
  }

  const report = done || reviewNews || checksReported;
  if (report && !done) watch.reviewsSince = now;
  return { notes, done, report, logOf, watch };
}

/** The run id behind a check's details link, for its failed log. */
export const runIdOf = (url: string | null) => (url ? (/\/actions\/runs\/(\d+)/.exec(url)?.[1] ?? null) : null);
