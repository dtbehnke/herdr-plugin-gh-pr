import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rollupChecks, type Check, type CiRollup } from "./label";

// Optional PR fields. Each one publishes its own token (`pr_<field>`), and the
// composite `pr` token joins the configured fields in configured order after
// the PR number. `ci` alone reproduces the original `#123 ✓` label.
export const FIELD_NAMES = ["ci", "threads", "bot", "unpushed"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export const DEFAULT_FIELDS: FieldName[] = ["ci"];

export function fieldToken(field: FieldName): string {
  return `pr_${field}`;
}

export interface Config {
  fields: FieldName[];
  // Check names matching this are "soft": they never turn the CI rollup red.
  softChecks: RegExp;
  // Comment/review authors matching this count as the bot.
  botAuthor: RegExp;
  // Only comments containing this marker count (latest one wins).
  botMarker: RegExp;
  // Run on that comment; group 1 is the decision word / the risk score.
  botDecision: RegExp;
  botScore: RegExp;
}

export const DEFAULT_SOFT_CHECKS = "coverage|codecov|coveralls";
// domerge risk-assessment comment (doinstruct/platform PR 6613).
export const DEFAULT_BOT_AUTHOR = "^doinstruct-merge(\\[bot\\])?$"; // gh GraphQL drops the [bot] suffix
export const DEFAULT_BOT_MARKER = "<!-- domerge:risk-assessment -->";
export const DEFAULT_BOT_DECISION = "\\*\\*Decision:\\*\\*\\s*([A-Za-z][\\w-]*)";
export const DEFAULT_BOT_SCORE = "\\*\\*Risk score:\\*\\*\\s*(\\d+)";

// Parse "ci, threads,bot" into known fields, keeping order, dropping unknown
// names and duplicates. Empty or all-unknown input yields the default.
export function parseFields(raw: string | undefined | null): FieldName[] {
  const seen: FieldName[] = [];
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase() as FieldName;
    if ((FIELD_NAMES as readonly string[]).includes(name) && !seen.includes(name)) {
      seen.push(name);
    }
  }
  return seen.length > 0 ? seen : [...DEFAULT_FIELDS];
}

function regexOr(source: unknown, fallback: string): RegExp {
  if (typeof source === "string" && source) {
    try {
      return new RegExp(source, "i");
    } catch {
      // fall through to the default for an invalid pattern
    }
  }
  return new RegExp(fallback, "i");
}

// Config comes from `<HERDR_PLUGIN_CONFIG_DIR>/config.json`, with env
// overrides GH_PR_FIELDS / GH_PR_SOFT_CHECKS / GH_PR_BOT_AUTHOR /
// GH_PR_BOT_MARKER / GH_PR_BOT_DECISION / GH_PR_BOT_SCORE. A plugin action runs in herdr's own environment, so the
// file is the channel that works for hook-invoked runs. A missing or corrupt
// file means defaults, never an error.
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  let file: Record<string, unknown> = {};
  const dir = env.HERDR_PLUGIN_CONFIG_DIR;
  if (dir) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      if (parsed && typeof parsed === "object") file = parsed as Record<string, unknown>;
    } catch {
      // no file or invalid JSON: defaults
    }
  }
  const fileFields = Array.isArray(file.fields) ? file.fields.join(",") : undefined;
  return {
    fields: parseFields(env.GH_PR_FIELDS ?? fileFields),
    softChecks: regexOr(env.GH_PR_SOFT_CHECKS ?? file.softChecks, DEFAULT_SOFT_CHECKS),
    botAuthor: regexOr(env.GH_PR_BOT_AUTHOR ?? file.botAuthor, DEFAULT_BOT_AUTHOR),
    botMarker: regexOr(env.GH_PR_BOT_MARKER ?? file.botMarker, DEFAULT_BOT_MARKER),
    botDecision: regexOr(env.GH_PR_BOT_DECISION ?? file.botDecision, DEFAULT_BOT_DECISION),
    botScore: regexOr(env.GH_PR_BOT_SCORE ?? file.botScore, DEFAULT_BOT_SCORE),
  };
}

export interface NamedCheck extends Check {
  name?: string;
  workflow?: string;
}

export interface CiResult {
  hard: CiRollup;
  // Number of soft checks that are failing, cancelled, or pending.
  softBad: number;
}

// Split checks into hard and soft by name (check name or workflow name), roll
// the hard ones up as before, and count soft checks that are not passing.
export function ciResult(checks: NamedCheck[], soft: RegExp): CiResult {
  const isSoft = (c: NamedCheck) => soft.test(c.name ?? "") || soft.test(c.workflow ?? "");
  const hard = checks.filter((c) => !isSoft(c));
  const softChecks = checks.filter(isSoft);
  const softBad = softChecks.filter((c) => c.bucket === "fail" || c.bucket === "cancel" || c.bucket === "pending").length;
  return { hard: rollupChecks(hard), softBad };
}

const CI_SYMBOL: Record<CiRollup, string> = { pass: "✓", fail: "✗", pending: "●", none: "" };

// "✓" / "✗" / "●" for the hard rollup, plus "~" when a soft check (coverage)
// is not passing. Soft only: just "~". Nothing to show: empty string.
export function ciText(result: CiResult): string {
  return `${CI_SYMBOL[result.hard]}${result.softBad > 0 ? "~" : ""}`;
}

export interface ReviewThread {
  isResolved?: boolean;
  isOutdated?: boolean;
}

// Unresolved threads, including outdated ones: a thread stays open until
// someone resolves it, whatever the diff did to its anchor line.
export function unresolvedCount(threads: ReviewThread[]): number {
  return threads.filter((t) => t.isResolved === false).length;
}

export function threadsText(count: number | null): string {
  return count ? `⚑${count}` : "";
}

export interface BotCandidate {
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
  submittedAt?: string;
}

// "<decision> <score>" (e.g. "blocked 57") from the newest bot comment that
// carries the marker, or null when there is none. Either part may be missing;
// a marked comment with neither yields "?".
export function botVerdict(
  items: BotCandidate[],
  cfg: Pick<Config, "botAuthor" | "botMarker" | "botDecision" | "botScore">,
): string | null {
  const bots = items
    .filter((i) => cfg.botAuthor.test(i.author?.login ?? "") && cfg.botMarker.test(i.body ?? ""))
    .map((i) => ({ body: i.body ?? "", at: i.createdAt ?? i.submittedAt ?? "" }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = bots.at(-1);
  if (!latest) return null;
  const parts = [latest.body.match(cfg.botDecision)?.[1], latest.body.match(cfg.botScore)?.[1]].filter(Boolean);
  return parts.length > 0 ? parts.join(" ").toLowerCase() : "?";
}

export function botText(verdict: string | null): string {
  return verdict ? `⚙${verdict}` : "";
}

// Commits on HEAD not on the upstream, from `git rev-list --count` output.
export function parseAheadCount(stdout: string): number | null {
  const n = Number(stdout.trim());
  return stdout.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : null;
}

export function unpushedText(count: number | null): string {
  return count ? `↑${count}` : "";
}

// Join the PR number and the configured fields' texts in configured order,
// skipping empty ones.
export function compositeLabel(prNumber: number, fields: FieldName[], texts: Partial<Record<FieldName, string>>): string {
  return [`#${prNumber}`, ...fields.map((f) => texts[f] ?? "").filter(Boolean)].join(" ");
}
