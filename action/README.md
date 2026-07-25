# Harness Score GitHub Action

Runs the deterministic [harness-score](https://paladini.github.io/harness-score/)
scanner in CI: reports the repository's AI-harness maturity level, writes a
branded SVG pill (`harness` · `L4`), and (optionally) fails the build below a minimum level so your harness only ratchets up. Because
the badge is re-rendered for the detected level on every run, publishing it
once gives you a self-updating README badge for free.

## Usage

```yaml
jobs:
  harness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: paladini/harness-score@main
        with:
          min-level: '3'          # fail below L3 (0 = report only)
          badge: 'harness-badge.svg'
```

A per-run summary (level + dimension table) appears in the job summary. To
publish the badge, upload it as an artifact or commit it to a `badges`
branch, then reference it from your README:

Pin a full commit SHA instead of `main` in production workflows. The legacy
`paladini/harness-score/action@<ref>` entrypoint remains compatible, but the
root entrypoint is recommended because GitHub dependency-review can associate
it with this repository's MIT license.

```markdown
<img alt="Harness Score" src="https://raw.githubusercontent.com/<you>/<repo>/badges/harness-badge.svg" height="20">
```

## Pull-request comments

Set `comment: 'true'` on a `pull_request` workflow to get a sticky comment
showing the score delta against the PR's base branch — "harness score moved
from L2 to L3 in this PR" instead of just a snapshot. It updates the same
comment on every push (matched via a hidden marker), rather than posting a
new one each time.

This is opt-in and requires the calling workflow to grant
`pull-requests: write` — the action cannot request that permission for you:

```yaml
on:
  pull_request:

permissions:
  pull-requests: write

jobs:
  harness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: paladini/harness-score@main
        with:
          comment: 'true'
```

Under the hood this scans the PR head (the normal step above), then scans
the base branch's tip commit into a temporary `git worktree` and diffs the
two with `harness-score --diff` — no extra checkout step needed, and no
history is written back to your repository.

Two pushes in quick succession can race and post two comments instead of
updating one. If that matters for your repo, add a concurrency group scoped
to the PR:

```yaml
concurrency:
  group: harness-score-${{ github.event.pull_request.number }}
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `min-level` | `0` | Fail when maturity is below this level (0–4) |
| `badge` | `harness-badge.svg` | SVG pill (`harness` + level); empty to skip |
| `report` | _(empty)_ | Markdown report output path |
| `working-directory` | `.` | Directory to scan |
| `version` | `latest` | harness-score npm version |
| `comment` | `false` | Post/update a sticky PR comment with the score delta (`pull_request` events only; requires `pull-requests: write`) |

## Outputs

`level` (0–4), `level-name`, `percent`.
