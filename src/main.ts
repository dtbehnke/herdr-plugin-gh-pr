import { $ } from "bun";
import {
  composeLabel,
  parsePrNumber,
  refreshingLabel,
  resolvePaneCwd,
  type PullRequestState,
} from "./label";
import {
  botText,
  botVerdict,
  ciResult,
  ciText,
  compositeLabel,
  FIELD_NAMES,
  fieldToken,
  loadConfig,
  parseAheadCount,
  threadsText,
  unpushedText,
  unresolvedCount,
  type BotCandidate,
  type Config,
  type FieldName,
  type NamedCheck,
  type ReviewThread,
} from "./fields";
import { lastCheckMs, recordCheck, THROTTLE_WINDOW_MS, throttleElapsed } from "./throttle";

const SOURCE = "gh-pr";

interface PaneCurrent {
  result?: {
    pane?: {
      pane_id?: string;
      cwd?: string;
      foreground_cwd?: string;
      tokens?: Record<string, string>;
    };
  };
}

interface Pane {
  paneId: string;
  cwd: string;
  currentStatus?: string;
}

interface PullRequest {
  number: number;
  state: PullRequestState;
  url: string;
  // Present only when the `bot` field asked for them.
  comments?: BotCandidate[];
  reviews?: BotCandidate[];
}

// Resolve a pane id, working directory, and current label from herdr. With no
// argument it uses the focused pane (the manifest's per-event behavior); pass a
// pane id to target a specific pane (used by the seed loop and a targeted
// refresh).
async function resolvePane(targetPaneId?: string): Promise<Pane | null> {
  const out = targetPaneId
    ? await $`herdr pane get ${targetPaneId}`.nothrow().quiet()
    : await $`herdr pane current`.nothrow().quiet();
  if (out.exitCode !== 0) return null;
  let parsed: PaneCurrent;
  try {
    parsed = JSON.parse(out.stdout.toString());
  } catch {
    return null;
  }
  const pane = parsed.result?.pane;
  const paneId = pane?.pane_id;
  const cwd = pane ? resolvePaneCwd(pane) : undefined;
  if (!paneId || !cwd) return null;
  return { paneId, cwd, currentStatus: pane?.tokens?.pr };
}

// Current branch name, or null if the dir is not a git work tree or is detached.
async function currentBranch(cwd: string): Promise<string | null> {
  const inside = await $`git -C ${cwd} rev-parse --is-inside-work-tree`.nothrow().quiet();
  if (inside.exitCode !== 0 || inside.stdout.toString().trim() !== "true") return null;
  const branch = await $`git -C ${cwd} rev-parse --abbrev-ref HEAD`.nothrow().quiet();
  if (branch.exitCode !== 0) return null;
  const name = branch.stdout.toString().trim();
  if (!name || name === "HEAD") return null;
  return name;
}

// PR identity for the branch, or null when the branch has no PR.
export async function prInfo(
  cwd: string,
  branch: string,
  withBotComments = false,
): Promise<PullRequest | null> {
  const json = withBotComments ? "number,state,url,comments,reviews" : "number,state,url";
  const out = await $`gh pr view ${branch} --json ${json}`.cwd(cwd).nothrow().quiet();
  if (out.exitCode !== 0) return null;
  try {
    const data = JSON.parse(out.stdout.toString()) as {
      number: number;
      state?: string;
      url?: string;
      comments?: BotCandidate[];
      reviews?: BotCandidate[];
    };
    if (typeof data.number !== "number" || typeof data.url !== "string") return null;
    const state = data.state === "CLOSED" || data.state === "MERGED" ? data.state : "OPEN";
    return {
      number: data.number,
      state,
      url: data.url,
      comments: Array.isArray(data.comments) ? data.comments : undefined,
      reviews: Array.isArray(data.reviews) ? data.reviews : undefined,
    };
  } catch {
    return null;
  }
}

// CI checks for the branch. gh pr checks exits non-zero when checks are
// failing or pending, so ignore the exit code and parse the JSON regardless.
async function prChecks(cwd: string, branch: string): Promise<NamedCheck[]> {
  const out = await $`gh pr checks ${branch} --json bucket,name,workflow`.cwd(cwd).nothrow().quiet();
  try {
    const data = JSON.parse(out.stdout.toString()) as NamedCheck[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const THREADS_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated}}}}}";

// Unresolved review-thread count (first 100 threads), or null when gh cannot
// answer. `:owner` and `:repo` are gh's own placeholders for the cwd's repo.
async function reviewThreads(cwd: string, prNumber: number): Promise<number | null> {
  const out = await $`gh api graphql -F owner=:owner -F repo=:repo -F number=${prNumber} -f query=${THREADS_QUERY}`
    .cwd(cwd)
    .nothrow()
    .quiet();
  if (out.exitCode !== 0) return null;
  try {
    const data = JSON.parse(out.stdout.toString());
    const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
    return Array.isArray(nodes) ? unresolvedCount(nodes as ReviewThread[]) : null;
  } catch {
    return null;
  }
}

// Commits on HEAD that the upstream does not have, or null without an upstream.
async function unpushedCommits(cwd: string): Promise<number | null> {
  const out = await $`git -C ${cwd} rev-list --count ${"@{upstream}..HEAD"}`.nothrow().quiet();
  return out.exitCode === 0 ? parseAheadCount(out.stdout.toString()) : null;
}

// `--token` / `--clear-token` args for one report-metadata call. An empty or
// null value clears the token so a field that went quiet does not linger.
export function metadataArgs(tokens: Record<string, string | null>): string[] {
  return Object.entries(tokens).flatMap(([name, value]) =>
    value ? ["--token", `${name}=${value}`] : ["--clear-token", name],
  );
}

// One call for every token. If herdr rejects the combined call, fall back to
// one call per token so a single bad flag does not lose the whole update.
async function reportTokens(paneId: string, tokens: Record<string, string | null>): Promise<void> {
  const args = metadataArgs(tokens);
  const all = await $`herdr pane report-metadata ${paneId} --source ${SOURCE} ${args}`.nothrow().quiet();
  if (all.exitCode === 0) return;
  for (const name of Object.keys(tokens)) {
    const one = metadataArgs({ [name]: tokens[name] });
    await $`herdr pane report-metadata ${paneId} --source ${SOURCE} ${one}`.nothrow().quiet();
  }
}

// Every field token, set to its text when configured and non-empty, else null.
function fieldTokens(cfg: Config, texts: Partial<Record<FieldName, string>>): Record<string, string | null> {
  const tokens: Record<string, string | null> = {};
  for (const field of FIELD_NAMES) {
    tokens[fieldToken(field)] = cfg.fields.includes(field) ? texts[field] || null : null;
  }
  return tokens;
}

async function setLabel(paneId: string, text: string): Promise<void> {
  await $`herdr pane report-metadata ${paneId} --source ${SOURCE} --token pr=${text}`.nothrow().quiet();
}

export async function run(targetPaneId?: string, force = false): Promise<void> {
  const pane = await resolvePane(targetPaneId);
  if (!pane) return;

  // Throttle the automatic (focus/worktree) path to one gh check per pane per
  // window. Manual refreshes pass force=true and always run.
  const now = Date.now();
  if (!force && !throttleElapsed(lastCheckMs(pane.paneId), now, THROTTLE_WINDOW_MS)) return;
  recordCheck(pane.paneId, now);

  const cfg = loadConfig();
  const branch = await currentBranch(pane.cwd);
  if (!branch) {
    // Left a repo (or detached HEAD), drop any stale label on this pane.
    await reportTokens(pane.paneId, { pr: null, ...fieldTokens(cfg, {}) });
    return;
  }

  // If the pane already shows a PR number, swap its icon for the refreshing
  // glyph while the (slower) gh queries run, so the update is visible.
  const previous = parsePrNumber(pane.currentStatus);
  if (previous !== null) {
    await setLabel(pane.paneId, refreshingLabel(previous));
  }

  const pr = await prInfo(pane.cwd, branch, cfg.fields.includes("bot"));
  if (pr === null) {
    // Branch has no PR, show nothing rather than a stale label.
    await reportTokens(pane.paneId, { pr: null, ...fieldTokens(cfg, {}) });
    return;
  }

  if (pr.state !== "OPEN") {
    // Merged or closed: the state glyph replaces every field.
    await reportTokens(pane.paneId, {
      pr: composeLabel(pr.number, "none", pr.state),
      ...fieldTokens(cfg, {}),
    });
    return;
  }

  // Fetch only what the configured fields need, in parallel.
  const want = (field: FieldName) => cfg.fields.includes(field);
  const [checks, threads, unpushed] = await Promise.all([
    want("ci") ? prChecks(pane.cwd, branch) : Promise.resolve([]),
    want("threads") ? reviewThreads(pane.cwd, pr.number) : Promise.resolve(null),
    want("unpushed") ? unpushedCommits(pane.cwd) : Promise.resolve(null),
  ]);
  const texts: Partial<Record<FieldName, string>> = {
    ci: ciText(ciResult(checks, cfg.softChecks)),
    threads: threadsText(threads),
    bot: want("bot") ? botText(botVerdict([...(pr.comments ?? []), ...(pr.reviews ?? [])], cfg)) : "",
    unpushed: unpushedText(unpushed),
  };
  await reportTokens(pane.paneId, {
    pr: compositeLabel(pr.number, cfg.fields, texts),
    ...fieldTokens(cfg, texts),
  });
}

// Open the PR for a pane's branch in the browser. With no argument it uses the
// focused pane; pass a pane id to target a specific pane. Does nothing if the
// pane is not in a repo or the branch has no PR.
export async function openPr(targetPaneId?: string): Promise<void> {
  const pane = await resolvePane(targetPaneId);
  if (!pane) return;

  const branch = await currentBranch(pane.cwd);
  if (!branch) return;

  const opened = await $`gh pr view ${branch} --web`.cwd(pane.cwd).nothrow().quiet();
  if (opened.exitCode === 0) return;

  // `gh pr view --web` shells out to xdg-open/open, which has no way to
  // launch a browser over a plain SSH session (no DISPLAY, no text browser
  // installed). That failure is otherwise silent from the pane's point of
  // view, so fall back to surfacing the PR URL directly: a toast (if the
  // user has ui.toast.delivery configured) and the plugin log.
  const pr = await prInfo(pane.cwd, branch);
  if (!pr) return;
  await $`herdr notification show ${"PR ready"} --body ${pr.url}`.nothrow().quiet();
  console.error(`[gh-pr] could not open a browser, PR URL: ${pr.url}`);
}
