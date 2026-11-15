// Pure helpers for the GitHub Actions run watcher (`wait_for_run`): which run a
// reference names, and what to tell the thread when a run finishes.

export type RunRef = { repo: string; runId: number };

/** A run id, `owner/name#id`, or an actions run URL; the repo defaults to the project's. */
export function parseRunRef(input: string | number, defaultRepo: string | null): RunRef {
  const text = String(input).trim();
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/.exec(text);
  if (url) return { repo: url[1]!, runId: Number(url[2]) };
  const slug = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text);
  if (slug) return { repo: slug[1]!, runId: Number(slug[2]) };
  if (/^\d+$/.test(text)) {
    if (!defaultRepo) throw new Error("This project has no GitHub remote. Pass repo, or the run's URL.");
    return { repo: defaultRepo, runId: Number(text) };
  }
  throw new Error(`"${text}" is not a run id, owner/name#id or an actions run URL.`);
}

export type RunState = {
  status: string;
  conclusion: string | null;
  name: string;
  displayTitle?: string;
  url: string;
  jobs?: Array<{ name: string; conclusion: string | null }>;
  /** Failed jobs beyond those listed. */
  jobsMore?: number;
};

const OK = new Set(["success", "neutral", "skipped"]);

/** Null while the run is still going; otherwise the message, and whether it failed. */
export function runOutcome(run: RunState, repo: string): { failed: boolean; text: string } | null {
  if (run.status !== "completed") return null;
  const where = `${repo.split("/")[1]} · ${run.name}${run.displayTitle ? ` (${run.displayTitle})` : ""}`;
  if (OK.has(run.conclusion ?? "")) return { failed: false, text: `✅ ${where} finished: ${run.conclusion}. ${run.url}` };
  const failedJobs = (run.jobs ?? [])
    .filter((job) => job.conclusion !== null && !OK.has(job.conclusion))
    .map((job) => job.name);
  const more = run.jobsMore ? ` and ${run.jobsMore} more` : "";
  const jobs = failedJobs.length > 0 ? ` Failed: ${failedJobs.join(", ")}${more}.` : "";
  return { failed: true, text: `❌ ${where} finished: ${run.conclusion ?? "unknown"}.${jobs} ${run.url}` };
}
