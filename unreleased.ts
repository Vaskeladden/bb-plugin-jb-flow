// What's merged but not released, per project repo. Two release styles:
// - a release branch (`main`) next to the default branch (`dev`): unreleased =
//   on dev but not yet on main;
// - otherwise the latest release or `v*` tag: unreleased = on the default
//   branch since that tag.
// PRs come from the compare's commit subjects ("… (#123)" squash merges and
// "Merge pull request #123" merges), with details from one GraphQL query.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Reads } from "./github";

export const unreleasedSchema = z.object({
  repo: z.string().nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  baseKind: z.enum(["branch", "tag"]).nullable(),
  releasedAt: z.number().nullable(),
  compareUrl: z.string().nullable(),
  prs: z.array(
    z.object({ number: z.number(), title: z.string(), url: z.string(), author: z.string(), mergedAt: z.number().nullable() }),
  ),
  /** Commits on the default branch without a PR (direct pushes). */
  directCommits: z.number(),
  error: z.string().nullable(),
  checkedAt: z.number(),
});
export type Unreleased = z.infer<typeof unreleasedSchema>;

const CACHE_MS = 5 * 60_000;
const RELEASE_BRANCHES = ["main", "master"];

export function repoSlug(remoteUrl: string | null | undefined): string | null {
  return remoteUrl?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

/** PR number from a commit subject, or null for a direct commit. Branch syncs return "skip". */
export function prFromSubject(subject: string): number | "skip" | null {
  const merge = subject.match(/^Merge pull request #(\d+)/);
  if (merge) return Number(merge[1]);
  if (/^Merge (remote-tracking )?branch /.test(subject)) return "skip";
  const squash = subject.match(/\(#(\d+)\)\s*$/);
  return squash ? Number(squash[1]) : null;
}

async function findBase(reads: Reads, repo: string, head: string): Promise<{ base: string; baseKind: "branch" | "tag" } | null> {
  const api = reads.rest;
  const exists = (path: string) => api<{ name?: string }>(path).then((value) => value, () => null);
  for (const branch of RELEASE_BRANCHES) {
    if (branch === head) continue;
    // GitHub redirects master -> main, so check the name that came back.
    const found = await exists(`repos/${repo}/branches/${branch}`);
    if (found?.name === branch) return { base: branch, baseKind: "branch" };
  }
  const latest = await api<{ tag_name?: string }>(`repos/${repo}/releases/latest`).catch(() => null);
  if (latest?.tag_name) return { base: latest.tag_name, baseKind: "tag" };
  const tags = await api<Array<{ name: string }>>(`repos/${repo}/tags?per_page=30`).catch(() => []);
  const tag = tags.find((t) => /^v?\d+\.\d+/.test(t.name));
  return tag ? { base: tag.name, baseKind: "tag" } : null;
}

async function compute(reads: Reads, repo: string): Promise<Unreleased> {
  const api = reads.rest;
  const empty = { repo, head: null, base: null, baseKind: null, releasedAt: null, compareUrl: null, prs: [], directCommits: 0, checkedAt: Date.now() };
  const { default_branch: head } = await api<{ default_branch: string }>(`repos/${repo}`);
  const found = await findBase(reads, repo, head);
  if (!found) return { ...empty, head, error: `No release branch or version tag found in ${repo}.` };
  const { base, baseKind } = found;
  const [compare, baseCommit] = await Promise.all([
    api<{ html_url: string; commits: Array<{ commit: { message: string } }> }>(
      `repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=250`,
    ),
    api<{ commit: { committer: { date: string } } }>(`repos/${repo}/commits/${encodeURIComponent(base)}`),
  ]);
  const numbers = new Set<number>();
  let directCommits = 0;
  for (const { commit } of compare.commits) {
    const pr = prFromSubject(commit.message.split("\n")[0] ?? "");
    if (pr === null) directCommits += 1;
    else if (pr !== "skip") numbers.add(pr);
  }
  const prs = (await reads.prDetails(repo, [...numbers]))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author?.login ?? "ghost",
      mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
    }))
    .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0));
  return {
    ...empty,
    head,
    base,
    baseKind,
    releasedAt: Date.parse(baseCommit.commit.committer.date),
    compareUrl: compare.html_url,
    prs,
    directCommits,
    error: null,
  };
}

export function createUnreleased(bb: BbPluginApi, reads: Reads) {
  const cache = new Map<string, Unreleased>();
  return async function unreleased(projectId: string, refresh: boolean): Promise<Unreleased> {
    const cached = cache.get(projectId);
    if (cached && !refresh && Date.now() - cached.checkedAt < CACHE_MS) return cached;
    const project = await bb.sdk.projects.get({ projectId });
    const repo = repoSlug(project.gitRemoteUrl);
    let result: Unreleased;
    if (repo === null) {
      result = { repo: null, head: null, base: null, baseKind: null, releasedAt: null, compareUrl: null, prs: [], directCommits: 0, error: "Pick a project with a GitHub repo to see what's unreleased.", checkedAt: Date.now() };
    } else {
      try {
        result = await compute(reads, repo);
      } catch (error) {
        // Keep showing the last good answer when GitHub hiccups.
        if (cached) return cached;
        result = { repo, head: null, base: null, baseKind: null, releasedAt: null, compareUrl: null, prs: [], directCommits: 0, error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
      }
    }
    cache.set(projectId, result);
    return result;
  };
}
