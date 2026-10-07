import { beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metadataArgs } from "../src/main";

// End-to-end through bin/update-pr-status.ts with fake `herdr`, `git` and `gh`
// executables first on PATH. gh output is canned: no network, no login.
let root: string;
let bin: string;

function script(name: string, body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gh-pr-test-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  script(
    "herdr",
    `if [ "$1 $2" = "pane current" ]; then
printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:p1","cwd":"${root}","tokens":{}}}}'
elif [ "$1 $2" = "pane report-metadata" ]; then
[ -n "$FAIL_COMBINED" ] && [ "$(echo "$@" | grep -o -- '--token\\|--clear-token' | wc -l)" -gt 1 ] && exit 1
printf '%s\\n' "$*" >> "$LOG"
fi`,
  );
  script(
    "git",
    `case "$*" in
*is-inside-work-tree*) echo true;;
*abbrev-ref*) echo feature;;
*rev-list*) echo "\${AHEAD:-2}";;
esac`,
  );
  script(
    "gh",
    `case "$*" in
"pr view"*comments*) printf '%s\\n' "$VIEW_BOT";;
"pr view"*) printf '%s\\n' "$VIEW";;
"pr checks"*) printf '%s\\n' "$CHECKS";;
"api graphql"*) printf '%s\\n' "$GRAPHQL";;
esac`,
  );
});


const VIEW = '{"number":42,"state":"OPEN","url":"https://example.test/pr/42"}';
const VIEW_BOT = JSON.stringify({
  number: 42,
  state: "OPEN",
  url: "https://example.test/pr/42",
  comments: [
    { author: { login: "doinstruct-merge[bot]" }, body: "<!-- domerge:risk-assessment -->\n**Risk score:** 10 / 100\n**Decision:** allowed", createdAt: "2026-10-01T00:00:00Z" },
    { author: { login: "doinstruct-merge[bot]" }, body: "<!-- domerge:risk-assessment -->\n**Risk score:** 57 / 100 (threshold 50)\n**Decision:** blocked — too risky", createdAt: "2026-10-05T00:00:00Z" },
  ],
  reviews: [],
});
const CHECKS = '[{"bucket":"pass","name":"test","workflow":"CI"},{"bucket":"fail","name":"codecov/patch","workflow":"Cov"}]';
const GRAPHQL = JSON.stringify({
  data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } } } },
});

async function runPlugin(extra: Record<string, string>): Promise<string[]> {
  const log = join(root, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(log, "");
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "update-pr-status.ts")], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      LOG: log,
      HERDR_PLUGIN_ACTION_ID: "refresh",
      HERDR_PLUGIN_STATE_DIR: join(root, "state"),
      VIEW,
      VIEW_BOT,
      CHECKS,
      GRAPHQL,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

test("metadataArgs sets non-empty values and clears empty or null ones", () => {
  expect(metadataArgs({ pr: "#1 ✓", pr_ci: "", pr_bot: null })).toEqual([
    "--token",
    "pr=#1 ✓",
    "--clear-token",
    "pr_ci",
    "--clear-token",
    "pr_bot",
  ]);
});

test("default config keeps the original label and clears the other field tokens", async () => {
  const calls = await runPlugin({});
  expect(calls).toHaveLength(1);
  // Coverage failing is soft: green tick plus the ~ marker.
  expect(calls[0]).toContain("--token pr=#42 ✓~");
  expect(calls[0]).toContain("--token pr_ci=✓~");
  expect(calls[0]).toContain("--clear-token pr_threads");
  expect(calls[0]).toContain("--clear-token pr_bot");
  expect(calls[0]).toContain("--clear-token pr_unpushed");
});

test("all four fields publish their own tokens and the ordered composite", async () => {
  const calls = await runPlugin({ GH_PR_FIELDS: "unpushed,threads,bot,ci" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--token pr=#42 ↑2 ⚑2 ⚙blocked 57/100 ✓~");
  expect(calls[0]).toContain("--token pr_threads=⚑2");
  expect(calls[0]).toContain("--token pr_bot=⚙blocked 57/100");
  expect(calls[0]).toContain("--token pr_unpushed=↑2");
});

test("zero unresolved threads and zero unpushed commits publish nothing", async () => {
  const calls = await runPlugin({
    GH_PR_FIELDS: "threads,unpushed",
    AHEAD: "0",
    GRAPHQL: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }] } } } } }),
  });
  expect(calls[0]).toContain("--token pr=#42 ");
  expect(calls[0]).not.toContain("pr_threads=");
  expect(calls[0]).toContain("--clear-token pr_threads");
  expect(calls[0]).toContain("--clear-token pr_unpushed");
});

test("a merged PR shows the state glyph and clears every field", async () => {
  const calls = await runPlugin({
    GH_PR_FIELDS: "ci,threads,bot,unpushed",
    VIEW_BOT: JSON.stringify({ number: 5, state: "MERGED", url: "https://example.test/pr/5" }),
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--token pr=#5 ◆");
  expect(calls[0]).toContain("--clear-token pr_ci");
});

test("falls back to one call per token when herdr rejects the combined call", async () => {
  const calls = await runPlugin({ GH_PR_FIELDS: "ci,unpushed", FAIL_COMBINED: "1" });
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.some((c) => c.includes("--token pr=#42"))).toBe(true);
  expect(calls.some((c) => c.includes("--token pr_unpushed=↑2"))).toBe(true);
});

test("no PR clears the label and all field tokens in one call", async () => {
  const calls = await runPlugin({ VIEW: "", GH_PR_FIELDS: "ci" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--clear-token pr ");
  expect(calls[0]).not.toContain("--token ");
});
