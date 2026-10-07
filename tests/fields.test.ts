import { expect, test } from "bun:test";
import {
  botText,
  botVerdict,
  ciResult,
  ciText,
  compositeLabel,
  DEFAULT_BOT_AUTHOR,
  DEFAULT_BOT_DECISION,
  DEFAULT_BOT_MARKER,
  DEFAULT_BOT_SCORE,
  DEFAULT_SOFT_CHECKS,
  loadConfig,
  parseAheadCount,
  parseFields,
  threadsText,
  unpushedText,
  unresolvedCount,
} from "../src/fields";

const soft = new RegExp(DEFAULT_SOFT_CHECKS, "i");
const cfg = {
  botAuthor: new RegExp(DEFAULT_BOT_AUTHOR, "i"),
  botMarker: new RegExp(DEFAULT_BOT_MARKER, "i"),
  botDecision: new RegExp(DEFAULT_BOT_DECISION, "i"),
  botScore: new RegExp(DEFAULT_BOT_SCORE, "i"),
};
const MARK = "<!-- domerge:risk-assessment -->";
const BOT = { login: "doinstruct-merge[bot]" };
const body = (decision: string, score: number) =>
  `${MARK}\n## Risk\n**Risk score:** ${score} / 100 (threshold 50)\n**Decision:** ${decision}`;

test("parseFields keeps order, drops unknown and duplicate names", () => {
  expect(parseFields("bot, ci,nope,bot,unpushed")).toEqual(["bot", "ci", "unpushed"]);
});

test("parseFields falls back to ci for empty or unknown input", () => {
  expect(parseFields(undefined)).toEqual(["ci"]);
  expect(parseFields("")).toEqual(["ci"]);
  expect(parseFields("nope")).toEqual(["ci"]);
});

test("coverage failing is soft: hard rollup stays green and a ~ is added", () => {
  const result = ciResult(
    [
      { bucket: "pass", name: "test" },
      { bucket: "fail", name: "codecov/patch" },
    ],
    soft,
  );
  expect(result).toEqual({ hard: "pass", softBad: 1 });
  expect(ciText(result)).toBe("✓~");
});

test("a failing hard check still wins over a passing soft one", () => {
  const result = ciResult([{ bucket: "fail", name: "lint" }, { bucket: "pass", name: "coverage" }], soft);
  expect(ciText(result)).toBe("✗");
});

test("soft match also applies to the workflow name", () => {
  const result = ciResult([{ bucket: "pending", name: "report", workflow: "Coverage" }], soft);
  expect(ciText(result)).toBe("~");
});

test("no checks gives empty ci text", () => {
  expect(ciText(ciResult([], soft))).toBe("");
});

test("unresolvedCount counts open threads including outdated ones", () => {
  expect(
    unresolvedCount([
      { isResolved: false },
      { isResolved: false, isOutdated: true },
      { isResolved: true },
    ]),
  ).toBe(2);
});

test("threadsText hides zero and null", () => {
  expect(threadsText(0)).toBe("");
  expect(threadsText(null)).toBe("");
  expect(threadsText(3)).toBe("⚑3");
});

test("botVerdict renders decision word and score from the real domerge comment", () => {
  const items = [{ author: BOT, body: body("blocked — risk score above threshold", 57), createdAt: "2026-10-05T00:00:00Z" }];
  expect(botVerdict(items, cfg)).toBe("blocked 57");
  expect(botText("blocked 57")).toBe("⚙blocked 57");
});

test("botVerdict accepts the bot login as gh reports it, without the [bot] suffix", () => {
  const items = [{ author: { login: "doinstruct-merge" }, body: body("held — awaiting human review", 76), createdAt: "2026-10-07T00:00:00Z" }];
  expect(botVerdict(items, cfg)).toBe("held 76");
});

test("botVerdict takes the latest marked comment, ignoring older, unmarked, and non-bot ones", () => {
  const items = [
    { author: BOT, body: body("blocked — x", 57), createdAt: "2026-10-01T00:00:00Z" },
    { author: BOT, body: body("allowed", 12), createdAt: "2026-10-03T00:00:00Z" },
    { author: BOT, body: "**Decision:** blocked\nno marker", createdAt: "2026-10-04T00:00:00Z" },
    { author: { login: "alice" }, body: body("blocked", 99), createdAt: "2026-10-05T00:00:00Z" },
  ];
  expect(botVerdict(items, cfg)).toBe("allowed 12");
});

test("botVerdict copes with a missing score, a missing decision, or neither", () => {
  const mk = (text: string) => [{ author: BOT, body: `${MARK}\n${text}`, createdAt: "1" }];
  expect(botVerdict(mk("**Decision:** approved"), cfg)).toBe("approved");
  expect(botVerdict(mk("**Risk score:** 8 / 100"), cfg)).toBe("8");
  expect(botVerdict(mk("hello"), cfg)).toBe("?");
});

test("botVerdict is null without a matching bot comment", () => {
  expect(botVerdict([{ author: { login: "alice" }, body: body("blocked", 1), createdAt: "1" }], cfg)).toBeNull();
  expect(botVerdict([], cfg)).toBeNull();
  expect(botText(null)).toBe("");
});

test("botVerdict honors custom patterns", () => {
  const custom = { ...cfg, botAuthor: /^x$/, botMarker: /MARK/, botDecision: /D=(\w+)/, botScore: /S=(\d+)/ };
  expect(botVerdict([{ author: { login: "x" }, body: "MARK D=ok S=3", createdAt: "1" }], custom)).toBe("ok 3");
});

test("parseAheadCount accepts counts and rejects junk", () => {
  expect(parseAheadCount("3\n")).toBe(3);
  expect(parseAheadCount("0\n")).toBe(0);
  expect(parseAheadCount("")).toBeNull();
  expect(parseAheadCount("fatal")).toBeNull();
  expect(unpushedText(2)).toBe("↑2");
  expect(unpushedText(0)).toBe("");
  expect(unpushedText(null)).toBe("");
});

test("compositeLabel orders fields as configured and skips empty ones", () => {
  const texts = { ci: "✓", threads: "", bot: "⚙OK", unpushed: "↑1" };
  expect(compositeLabel(7, ["ci"], texts)).toBe("#7 ✓");
  expect(compositeLabel(7, ["unpushed", "bot", "threads", "ci"], texts)).toBe("#7 ↑1 ⚙OK ✓");
});

test("loadConfig defaults to ci only and honors env and invalid patterns", () => {
  expect(loadConfig({}).fields).toEqual(["ci"]);
  const c = loadConfig({ GH_PR_FIELDS: "threads,ci", GH_PR_SOFT_CHECKS: "(" });
  expect(c.fields).toEqual(["threads", "ci"]);
  expect(c.softChecks.test("codecov")).toBe(true); // invalid pattern falls back
});
