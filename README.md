# CI Speed Check

A GitHub Action that reads your workflow files and reports, by file, line and job, what makes your CI slower than it needs to be. Optional Pro mode adds a measured report from your repository's run history.

The free checks run entirely on the runner. Nothing is uploaded.

## Quick start

Add `.github/workflows/ci-speed-check.yml`:

```yaml
name: CI speed check
on:
  pull_request:
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  ci-speed-check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: weioai/ci-speed-check@v1
```

Each finding appears as a warning or notice on the workflow file and in the job summary, with a short YAML fix. By default the action never fails your build.

This example passes its own slowness and hygiene checks. Like any third-party action, `weioai/ci-speed-check@v1` is a moving tag, so the security check reports it too. To silence that, pin the action to a full commit SHA: `uses: weioai/ci-speed-check@<full 40-character SHA> # v1`.

## What you get

- Annotations on the workflow file at the line that needs changing (defects as warnings, observations as notices; GitHub shows at most 10 of each per step, the summary lists all).
- A job summary: a findings table (file, job, check, class, detail), one fix snippet per kind of finding, and what this check cannot see.
- A JSON report written to `RUNNER_TEMP`, for your own tooling or an upload step.
- Step outputs: `findings`, `defects`, `pro`, `report`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.github/workflows` | Folder (searched recursively) or single file with the workflow files to check, relative to the workspace. Must be inside the workspace. |
| `fail-on` | `none` | `none`, `defect` or `any`. The action exits 1 only when the static findings meet this threshold: `defect` fails on any defect, `any` on any finding (including observations). Problems with Pro never fail the job. |
| `annotate` | `true` | Set to `false` to skip the annotations (summary, outputs and report are still produced). |
| `api-key` | none | Weio API key (`wk_...`) that enables Pro. Pass it as a secret. |
| `github-token` | `${{ github.token }}` | Used only to read this repository's Actions run history from the GitHub API in Pro mode. Needs `permissions: actions: read`. |
| `repository` | `${{ github.repository }}` | Repository whose run history Pro reads, as `owner/name`. |
| `history-runs` | `100` | Pro: how many of the most recent runs to analyse (1 to 300). |
| `history-days` | `30` | Pro: how many days back to look. |

## Outputs

| Output | Description |
| --- | --- |
| `findings` | Number of findings (defects and observations) in the checked workflow files. |
| `defects` | Number of findings with severity `defect`. |
| `pro` | `true` when the Pro run-history report was produced, otherwise `false`. |
| `report` | Path of the JSON report, written to `RUNNER_TEMP` (or the OS temp directory). |

## The checks

Five deterministic rules, the same engine as Weio's [free web check](https://automation.weio.ai/ci-check.html) and the paid CI audit. No model is involved, so the same files give the same findings every time.

| Check | Class | Severity | What it flags | Fix |
| --- | --- | --- | --- | --- |
| `no-concurrency-cancel` | slowness | defect | A workflow triggered by `push` or `pull_request` with no top-level `concurrency` group, so runs for superseded commits keep running. | Add a concurrency group with `cancel-in-progress: true`. |
| `setup-without-cache` | slowness | defect | `actions/setup-node`, `setup-python`, `setup-java`, `setup-go`, `setup-dotnet` or `ruby/setup-ruby` without their cache input, so dependencies are downloaded every run. | Set `cache:` (`bundler-cache:` for Ruby). |
| `full-history-checkout` | slowness | observation | `actions/checkout` with `fetch-depth: 0`. Reported, not condemned: release tooling often needs full history. | Use `fetch-depth: 1` unless something reads git history. |
| `no-job-timeout` | hygiene | defect | A job with no `timeout-minutes` (jobs that call a reusable workflow are skipped). A hang costs the 360-minute default. | Add `timeout-minutes`. |
| `unpinned-third-party-action` | security | defect | A step using a non-`actions/` action at a tag or branch instead of a full 40-character commit SHA. | Pin to the commit SHA and keep the tag in a comment. |

The class tells you why it matters: slowness findings explain slow pipelines, hygiene and security findings are real but are not why a pipeline is slow.

The fixes, as the action prints them:

```yaml
# no-concurrency-cancel
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true   # use false for deploy workflows

# no-job-timeout (under the job)
timeout-minutes: 15   # about 2-3x the job's normal run time

# setup-without-cache (on the setup step; the value depends on the action)
with:
  cache: npm   # pip, maven, true for go and dotnet; bundler-cache: true for ruby/setup-ruby

# full-history-checkout (on the checkout step)
with:
  fetch-depth: 1   # the default; keep 0 only if something reads git history

# unpinned-third-party-action
uses: owner/action@<full 40-character commit SHA>   # v2
# find the SHA: gh api repos/owner/action/commits/v2 --jq .sha
```

### Where this differs from the web check and the paid audit

Three deliberate differences, each covered by a test that compares this implementation with the original engine:

1. A setup step whose cache input is explicitly `false` (`cache: false`, `bundler-cache: false`) is not flagged. That is a decision, not an oversight.
2. `actions/setup-go` at major ref `v4` or later is not flagged, because it caches by default from `v4`.
3. `actions/setup-node` at major ref `v5` or later is reported as an observation instead of a defect: v5 caches npm automatically only when `package.json` declares `packageManager`, so check that yours does, or set `cache: npm`.

Refs that are not version tags (commit SHAs, branches) are judged as before, since the action cannot tell which version they point at.

### What it cannot see

A clean result means these five rules found nothing in these files. It does not mean your CI is fast.

- How long your builds and tests take. It reads configuration, not runs. Pro measures real runs.
- Runner size, flaky tests, cache hit rates, or whether a cache key is any good.
- The inside of reusable workflows and composite actions: only the workflow files under `path` are read.
- Whether a job-level reusable workflow reference (`uses:` on a job) is pinned. Only step-level actions are checked.
- Whether your triggers suit your team. A missing concurrency group is a defect for CI, not for a deploy that must finish.
- One known quirk, kept so results match the original engine: a `docker://image@sha256:...` step reference is reported as an unpinned action even though a digest is a pin.

## Pro: run-history report

Pro adds measured numbers from your repository's real run history, in minutes only. It never shows a dollar figure.

The report contains:

- **Totals**: runs analysed, completed runs, runner minutes (each job's duration rounded up to a whole minute, the way GitHub bills private repositories) and wall-clock minutes.
- **Superseded runs**: runs that were still running after a newer run of the same workflow, branch and event had started, and the runner minutes they spent after that point, with a per-workflow top 5. Runs already cancelled (concurrency doing its job) are counted separately.
- **Slowest jobs**: runs, median, p90 and total minutes per job, top 10.
- **Slowest steps**: total time per step, top 10.
- **Queue time**: median and p90 wait from job creation to a runner starting it, per runner label set, flagged when p90 is over 2 minutes.
- **Failures and re-runs**: failure rate and minutes spent on failed runs per workflow, and how many runs were re-run.
- **How it was measured**: the sample window, what was and was not counted, and whether the report is partial (the action stops early if the GitHub API rate limit runs low).

To use it, give the job `permissions: actions: read` and pass a key:

```yaml
name: CI speed check (weekly)
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
  actions: read
jobs:
  ci-speed-check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: weioai/ci-speed-check@v1
        with:
          api-key: ${{ secrets.WEIO_API_KEY }}
```

One Pro run uses one credit, so run it on a schedule or by hand rather than on every pull request.

**The key.** A Weio API key costs $9 for 1,000 credits. It is emailed automatically within minutes of Stripe payment and is valid for 12 months. The same key also works for Weio's site-check API. One Pro run = one credit. [Get a key](https://weio.ai/services/site-check-api.html).

**When a credit is used.** After GitHub has granted access to the run list and before any job data is read. If GitHub denies access, or the window holds no runs, no credit is used. If Weio cannot use a credit (invalid key, no credits left, expired key, rate limit, or Weio is unreachable), the action prints a warning with Weio's message and a link to get a key, skips Pro, and carries on with the free checks. A problem with Pro never fails your job.

## Privacy

- **Free mode**: the action reads the workflow files in your workspace and makes no network requests. Nothing leaves the runner.
- **Pro mode**: your run history is read from the GitHub API with your `github-token` and stays on the runner (it ends up in the job summary and the JSON report). The only request to weio.ai carries the API key and the `owner/repo` string, to debit one credit (plus the usual HTTP metadata, such as the runner's IP address and the action's user-agent). No workflow content, run data, logs or GitHub token are sent to Weio.
- The GitHub token is only ever sent to the GitHub API address the runner provides (`GITHUB_API_URL`).
- The API key is masked in logs the moment the action starts and is never written to the summary, report or outputs.
- No telemetry, no analytics, no other network calls.
- The JSON report stays in `RUNNER_TEMP` unless you add a step that uploads it.

## Compatibility

Zero runtime dependencies: js-yaml 4.1.0 is vendored under `src/vendor` (MIT license included) and the rest is plain CommonJS written for Node 18 and later. Tests: `npm test`.

## About

Made by Weio, Inc., a small California company where AI operators do most of the work and a human owner is accountable for it. This action, its tests and this page were written by AI operators at Weio.

Questions, bugs and rule suggestions: open an issue on this repository. Sales and keys: sales@weio.ai.

MIT licensed. See `LICENSE`.
