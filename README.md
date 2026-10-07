# herdr-plugin-gh-pr

Shows the GitHub PR status of the focused **agent** pane's current git branch as a label on that pane's row in the herdr sidebar. The label reads like `#123 ✓` (the PR number plus a compact status symbol: ✓ passing CI, ✗ failing CI, ● pending CI, ◆ merged, ⊘ closed, and no symbol for an open PR with no checks). While the status is being recomputed, the symbol is replaced with `⟳`.

## Requirements

- herdr >= 0.7.4
- `bun`, `git`, and `gh` (authenticated: `gh auth status`) on your PATH

## Install

From GitHub (your local git must have access, the repo is private):

```bash
herdr plugin install wyattjoh/herdr-plugin-gh-pr
```

Or link a local checkout for development:

```bash
herdr plugin link /path/to/herdr-plugin-gh-pr
```

That is the entire install. No daemon, no config. herdr runs the hooks with `bun`, so `bun` must be on your PATH.

### Optional keybindings

herdr has no plugin-extensible right-click menu, and a plugin cannot ship its own keybinding (the manifest has no `key` field and keybindings live only in the user's config). To trigger the actions with a keystroke, add them to `~/.config/herdr/config.toml` and run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "gh-pr.open-pr"
description = "open PR in browser"

[[keys.command]]
key = "prefix+i"
type = "plugin_action"
command = "gh-pr.refresh"
description = "refresh PR status"
```

Then press your prefix (default `ctrl+b`) followed by `u` (open PR) or `i` (refresh status). Avoid `alt+` chords (they emit characters in the terminal), and pick a key that does not collide with a built-in: `o` (notifications), `g` (goto), `r` (resize), `v` (split), and `e` (edit scrollback) are taken by default. `herdr server reload-config` reports any conflict as a `partial` status.

## Sidebar setup

The plugin writes its label to a named `pr` token (`pane.report_metadata --token pr=VALUE`). herdr's
packed sidebar row layout only shows tokens you place in your row config, so add `$pr` to the agent
row in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "$pr"], ["agent"]]
```

Then `herdr server reload-config`. Without `$pr` in a row, the token is still written but nothing
renders it.

## Fields

By default the `pr` token is `#123 ✓`. Extra fields are opt-in and ordered by config. Each field also
gets its own token, so you can place it on its own sidebar row:

| Field | Token | Shows | Source |
|-------|-------|-------|--------|
| `ci` | `pr_ci` | `✓` `✗` `●`, plus `~` when a soft check is not passing | `gh pr checks` |
| `threads` | `pr_threads` | `⚑N` unresolved review threads (hidden at 0) | `gh api graphql` |
| `bot` | `pr_bot` | `⚙<decision> <score>` (e.g. `⚙blocked 57`) from the newest domerge risk-assessment comment | `gh pr view --json comments,reviews` |
| `unpushed` | `pr_unpushed` | `↑N` local commits not on the upstream (hidden at 0 or no upstream) | `git rev-list --count @{upstream}..HEAD` |

Coverage is soft: a check whose name or workflow matches `coverage|codecov|coveralls` never turns the
CI symbol red. If it is failing or pending, `~` is appended (`✓~`).

Pick and order the fields in `<plugin config dir>/config.json` (`herdr plugin config-dir gh-pr`):

```json
{
  "fields": ["ci", "threads", "bot", "unpushed"],
  "softChecks": "coverage|codecov|coveralls",
  "botAuthor": "^doinstruct-merge\\[bot\\]$",
  "botMarker": "<!-- domerge:risk-assessment -->",
  "botDecision": "\\*\\*Decision:\\*\\*\\s*([A-Za-z][\\w-]*)",
  "botScore": "\\*\\*Risk score:\\*\\*\\s*(\\d+)"
}
```

The bot field reads the newest comment whose author matches `botAuthor` and which contains
`botMarker`. `botDecision` and `botScore` (capture group 1) pick the decision word and the risk score
from it; the token reads `blocked 57`. A marked comment with neither match shows `?`. Environment
variables `GH_PR_FIELDS`, `GH_PR_SOFT_CHECKS`, `GH_PR_BOT_AUTHOR`, `GH_PR_BOT_MARKER`,
`GH_PR_BOT_DECISION`, and `GH_PR_BOT_SCORE` override the file for direct runs. Only the data a chosen
field needs is fetched. Review threads beyond the first 100 are not counted.

The `pr` token joins the fields in the configured order (`#123 ↑1 ⚑2 ⚙blocked 57 ✓`). To show a field on
its own row instead, add `$pr_threads` etc. to your row config.

## Use

Focus an agent pane sitting in a git repo whose branch has a PR. The label appears and refreshes when you switch panes or open/create worktrees. To avoid hammering the GitHub API, the automatic path checks at most once per pane every 30 seconds; a manual refresh always updates immediately.

Refresh the focused pane's PR status on demand:

```bash
herdr plugin action invoke gh-pr.refresh
```

Open the focused pane's branch PR in the browser:

```bash
herdr plugin action invoke gh-pr.open-pr
```

The qualified action id uses a dot (`gh-pr.open-pr`), not a slash.

## Develop

- `bun test` runs the unit tests.
- `herdr plugin log list gh-pr` shows hook output.
