"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const history = require("../src/history");
const M = require("./mocks");

const API = "https://github.test";
const base = (over) => Object.assign({
  owner: "acme", repo: "widgets", token: "ghs_testtoken", maxRuns: 100, days: 30, apiBase: API, now: M.NOW
}, over);

function harness(scn, handlerOpts) {
  const log = [];
  const calls = [];
  const handler = M.makeHandler(scn, Object.assign({log}, handlerOpts || {}));
  return {log, calls, fetchImpl: M.fetchFrom(handler, calls)};
}

/* The scenario, worked by hand (all times 2026-09-30, UTC; "ceil" = round up to whole minutes per job):
 *
 *  Run A  101 CI feature pull_request 10:00:00-10:09:10  jobs: build 10:00:30-10:09:10 (520 s -> 9)
 *                                                              lint  10:00:30-10:02:00 (90 s -> 2)
 *                                                              deploy 10:03:00-10:05:30 (150 s -> 3)       = 14
 *  Run B  102 same group, started 10:04:00 (before A ended)   build 10:04:30-10:12:00 (450 s -> 8), docs skipped = 8
 *  Run C  103 same group, started 10:20:00 (after B ended), failure, attempt 2   build 270 s -> 5            = 5
 *  Run E  105 CI other push, cancelled, 11:00:00-11:01:10      build 50 s -> 1                                = 1
 *  Run F  106 same group, started 11:00:50 (before E ended)    build 120 s -> 2                               = 2
 *  Run G  107 CI main workflow_dispatch, cancelled              smoke 10 s -> 1                                = 1
 *  Run H  108 Lint main push 12:00:00-12:03:00                 eslint 170 s -> 3                              = 3
 *  Run I  109 Lint main push started 12:01:00                  eslint 50 s -> 1                               = 1
 *  Run J  110 CI late push, in progress (no jobs read)
 *
 *  runner minutes = 14+8+5+1+2+1+3+1 = 35.  runs 9, completed 8.
 *  wall clock = 550+480+300+70+130+10+180+60 = 1780 s = 29.7 min (one decimal).
 *
 *  A is superseded by B (B started 10:04:00 < A ended 10:09:10). Waste = A's jobs after 10:04:00:
 *     build 10:09:10 - 10:04:00 = 310 s -> 6;  lint ended 10:02:00 -> 0;  deploy 10:05:30 - 10:04:00 = 90 s -> 2;  = 8
 *  B is not superseded (C started 10:20:00, after B ended).  C: nothing newer.
 *  E is cancelled and F started before it ended: counted as cancelled-by-supersession, not as waste.
 *  F: nothing newer.  G is a manual cancel on a workflow_dispatch run: cancelled, but not superseded.
 *  H is superseded by I (12:01:00 < 12:03:00): eslint 12:03:00 - 12:01:00 = 120 s -> 2.
 *  total superseded = 2 runs (A, H), waste 8 + 2 = 10 minutes = 28.6% of 35.
 */
test("superseded scenario: exact totals, waste and cancelled runs", async () => {
  const h = harness(M.scenario());
  const r = await history.analyze(base({fetchImpl: h.fetchImpl}));
  assert.equal(r.repo, "acme/widgets");
  assert.deepEqual(r.totals, {runs: 9, completed: 8, runnerMinutes: 35, wallClockMinutes: 29.7});
  assert.equal(r.superseded.runs, 2);
  assert.equal(r.superseded.wasteMinutes, 10);
  assert.equal(r.superseded.wastePercentOfRunnerMinutes, 28.6);
  assert.equal(r.superseded.cancelled, 2);
  assert.equal(r.superseded.cancelledBySupersession, 1);
  assert.deepEqual(r.superseded.byWorkflow, [
    {workflow: "CI", runs: 7, supersededRuns: 1, wasteMinutes: 8},
    {workflow: "Lint", runs: 2, supersededRuns: 1, wasteMinutes: 2}
  ]);
  assert.equal(r.partial, false);
  assert.equal(r.partialReason, null);
  assert.equal(r.window.since, "2026-09-01");
  assert.equal(r.generatedAt, "2026-10-01T00:00:00.000Z");
  // the in-progress run J never gets a jobs call; every completed run gets exactly one
  assert.deepEqual(h.log.filter((x) => x.startsWith("jobs:")).sort(),
    ["jobs:101", "jobs:102", "jobs:103", "jobs:105", "jobs:106", "jobs:107", "jobs:108", "jobs:109"]);
});

test("superseded scenario: jobs, steps, queue and failures", async () => {
  const h = harness(M.scenario());
  const r = await history.analyze(base({fetchImpl: h.fetchImpl}));

  // (CI, build): 520 s, 450 s, 270 s, 50 s, 120 s -> 9+8+5+1+2 = 25 min; median 270 s, p90 (nearest rank) 520 s
  assert.deepEqual(r.slowestJobs[0], {workflow: "CI", job: "build", runs: 5, medianSeconds: 270, p90Seconds: 520, totalMinutes: 25});
  // (Lint, eslint): 170 s and 50 s -> 4 min; median 110 s, p90 170 s
  assert.deepEqual(r.slowestJobs[1], {workflow: "Lint", job: "eslint", runs: 2, medianSeconds: 110, p90Seconds: 170, totalMinutes: 4});
  assert.deepEqual(r.slowestJobs.map((j) => j.job), ["build", "eslint", "deploy", "lint", "smoke"]);   // skipped docs excluded

  // Run tests: 400 s (A) + 300 s (B) = 700 s = 11.7 min over 2 runs
  assert.deepEqual(r.slowestSteps[0], {workflow: "CI", job: "build", step: "Run tests", runs: 2, totalSeconds: 700, totalMinutes: 11.7, meanSeconds: 350});
  assert.equal(r.slowestSteps[1].step, "Set up job");

  // ubuntu-latest queue: 10,10,10,15,20,30,30,30,30 -> median 20, p90 30.  self-hosted: one job waited 180 s.
  const byLabel = Object.fromEntries(r.queue.map((q) => [q.labels, q]));
  assert.deepEqual(byLabel["ubuntu-latest"], {labels: "ubuntu-latest", jobs: 9, medianSeconds: 20, p90Seconds: 30, flagged: false});
  assert.deepEqual(byLabel["linux, self-hosted"], {labels: "linux, self-hosted", jobs: 1, medianSeconds: 180, p90Seconds: 180, flagged: true});
  assert.equal(r.queue[0].labels, "linux, self-hosted");   // sorted by p90, worst first

  // C failed (attempt 2): 1 of 6 completed CI runs, 5 minutes
  assert.deepEqual(r.failures.byWorkflow[0], {workflow: "CI", completed: 6, failed: 1, failureRatePercent: 16.7, failedMinutes: 5});
  assert.deepEqual(r.failures.byWorkflow[1], {workflow: "Lint", completed: 2, failed: 0, failureRatePercent: 0, failedMinutes: 0});
  assert.equal(r.failures.failedRuns, 1);
  assert.equal(r.failures.failedMinutes, 5);
  assert.equal(r.failures.rerunRuns, 1);
});

test("the credit hook runs after the first runs page and before any jobs call", async () => {
  const h = harness(M.scenario());
  let calls = 0;
  await history.analyze(base({
    fetchImpl: h.fetchImpl,
    onFirstPage: async () => { calls++; h.log.push("credit"); }
  }));
  assert.equal(calls, 1);
  assert.equal(h.log[0], "runs:1");
  assert.equal(h.log[1], "credit");
  assert.ok(h.log.slice(2).every((x) => x.startsWith("jobs:")));
  assert.equal(h.log.length, 2 + 8);
});

test("requests are well formed: urls, headers, and the token only goes to the api base", async () => {
  const h = harness(M.scenario());
  await history.analyze(base({fetchImpl: h.fetchImpl, apiBase: API + "/"}));
  const first = h.calls[0];
  assert.equal(first.method, "GET");
  const u = new URL(first.url);
  assert.equal(u.origin + u.pathname, API + "/repos/acme/widgets/actions/runs");
  assert.equal(u.searchParams.get("per_page"), "100");
  assert.equal(u.searchParams.get("created"), ">=2026-09-01");
  for (const c of h.calls) {
    assert.ok(c.url.startsWith(API + "/repos/acme/widgets/actions/runs"), c.url);
    assert.equal(c.headers.Authorization, "Bearer ghs_testtoken");
    assert.ok(!/ghs_testtoken/.test(c.url));
  }
  const jobsCall = h.calls.find((c) => /\/runs\/101\/jobs/.test(c.url));
  assert.equal(new URL(jobsCall.url).searchParams.get("per_page"), "100");
});

test("no token means no Authorization header", async () => {
  const h = harness(M.scenario());
  await history.analyze(base({fetchImpl: h.fetchImpl, token: ""}));
  assert.ok(h.calls.every((c) => !("Authorization" in c.headers)));
});

for (const status of [401, 403, 404]) {
  test("runs request " + status + " -> NO_ACCESS, the credit hook is never called, no jobs requests", async () => {
    const h = harness(M.scenario(), {runsStatus: status});
    let credit = 0;
    await assert.rejects(
      history.analyze(base({fetchImpl: h.fetchImpl, onFirstPage: async () => { credit++; }})),
      (e) => {
        assert.equal(e.code, "NO_ACCESS");
        assert.equal(e.status, status);
        assert.ok(e instanceof history.HistoryError);
        assert.match(e.message, /permissions: actions: read/);
        assert.match(e.message, /acme\/widgets/);
        return true;
      });
    assert.equal(credit, 0);
    assert.deepEqual(h.log, ["runs:1"]);
  });
}

test("a 403 caused by an exhausted rate limit is reported as RATE_LIMITED, not as missing permissions", async () => {
  const h = harness(M.scenario(), {runsStatus: 403, runsHeaders: {"x-ratelimit-remaining": "0"}});
  let credit = 0;
  await assert.rejects(history.analyze(base({fetchImpl: h.fetchImpl, onFirstPage: async () => { credit++; }})),
    (e) => e.code === "RATE_LIMITED" && /rate limit/i.test(e.message));
  assert.equal(credit, 0);
});

test("other runs-list failures are typed GITHUB_ERROR; network failure too", async () => {
  const h = harness(M.scenario(), {runsStatus: 502});
  await assert.rejects(history.analyze(base({fetchImpl: h.fetchImpl})), (e) => e.code === "GITHUB_ERROR" && e.status === 502);
  await assert.rejects(history.analyze(base({fetchImpl: async () => { throw new TypeError("fetch failed"); }})),
    (e) => e.code === "GITHUB_ERROR" && /network/.test(e.message));
});

test("onFirstPage throwing aborts before any jobs call and propagates the same error", async () => {
  const h = harness(M.scenario());
  const boom = new Error("credit refused");
  await assert.rejects(history.analyze(base({fetchImpl: h.fetchImpl, onFirstPage: async () => { throw boom; }})),
    (e) => e === boom);
  assert.deepEqual(h.log, ["runs:1"]);
});

test("rate limit: stops reading jobs when x-ratelimit-remaining falls below 20 and marks the report partial", async () => {
  const h = harness(M.scenario(), {jobsRemaining: (idx) => (idx === 0 ? 19 : 18)});
  const r = await history.analyze(base({fetchImpl: h.fetchImpl, concurrency: 1}));
  assert.equal(r.partial, true);
  assert.match(r.partialReason, /rate limit/i);
  assert.equal(h.log.filter((x) => x.startsWith("jobs:")).length, 1);
  assert.equal(r.totals.runs, 9);                       // the run list itself is complete
  assert.ok(r.method.some((m) => /^Partial report/.test(m)));
  assert.ok(r.method.some((m) => /7 completed runs were not read/.test(m)));
  assert.match(history.renderMarkdown(r), /Partial report/);
});

test("rate limit: exactly 20 remaining is still fine", async () => {
  const h = harness(M.scenario(), {jobsRemaining: () => 20});
  const r = await history.analyze(base({fetchImpl: h.fetchImpl, concurrency: 1}));
  assert.equal(r.partial, false);
  assert.equal(h.log.filter((x) => x.startsWith("jobs:")).length, 8);
});

test("rate limit: a low count already on the first runs page stops before the first jobs call (after the credit hook)", async () => {
  const h = harness(M.scenario(), {runsRemaining: 5});
  let credit = 0;
  const r = await history.analyze(base({fetchImpl: h.fetchImpl, onFirstPage: async () => { credit++; }}));
  assert.equal(credit, 1);
  assert.equal(r.partial, true);
  assert.equal(h.log.filter((x) => x.startsWith("jobs:")).length, 0);
});

test("rate limit: a 403/429 on a jobs request stops the run and marks it partial", async () => {
  const h = harness(M.scenario(), {jobsStatus: {101: 429}});
  const r = await history.analyze(base({fetchImpl: h.fetchImpl, concurrency: 1}));
  assert.equal(r.partial, true);
  assert.match(r.partialReason, /HTTP 429/);
});

test("a failing jobs request for one run is skipped and noted, not fatal", async () => {
  const h = harness(M.scenario(), {jobsStatus: {103: 500}});
  const r = await history.analyze(base({fetchImpl: h.fetchImpl, concurrency: 1}));
  assert.equal(r.partial, false);
  assert.equal(r.totals.completed, 8);
  assert.equal(r.totals.runnerMinutes, 35 - 5);         // run C's five minutes could not be read
  assert.ok(r.method.some((m) => /1 completed run could not have their jobs read/.test(m)));
});

test("pagination: pages of 100, capped at maxRuns, deduplicated", async () => {
  const runs = [];
  for (let i = 0; i < 250; i++) runs.push(M.run(1000 + i, "10:00:00", "10:01:00", {head_branch: "b" + i, status: "in_progress", conclusion: null}));
  runs.splice(120, 0, runs[5]);                         // a duplicate that shifted onto page 2
  const h = harness({runs, jobs: {}});
  const r = await history.analyze(base({fetchImpl: h.fetchImpl, maxRuns: 130}));
  assert.equal(r.totals.runs, 130);
  assert.deepEqual(h.log, ["runs:1", "runs:2"]);
  assert.equal(r.window.maxRuns, 130);
  assert.ok(r.method[0].includes("The window holds 251 runs, so the oldest were left out."));
});

test("maxRuns is clamped to 300 and defaults to 100; days default to 30 and clamp", async () => {
  const runs = [];
  for (let i = 0; i < 400; i++) runs.push(M.run(2000 + i, "10:00:00", "10:01:00", {head_branch: "b" + i, status: "queued", conclusion: null}));
  let h = harness({runs, jobs: {}});
  let r = await history.analyze(base({fetchImpl: h.fetchImpl, maxRuns: 5000}));
  assert.equal(r.totals.runs, 300);
  assert.deepEqual(h.log, ["runs:1", "runs:2", "runs:3"]);
  h = harness({runs, jobs: {}});
  r = await history.analyze(base({fetchImpl: h.fetchImpl, maxRuns: undefined, days: undefined}));
  assert.equal(r.totals.runs, 100);
  assert.equal(r.window.days, 30);
  r = await history.analyze(base({fetchImpl: harness({runs: [], jobs: {}}).fetchImpl, days: 100000}));
  assert.equal(r.window.days, 365);
  r = await history.analyze(base({fetchImpl: harness({runs: [], jobs: {}}).fetchImpl, maxRuns: 0, days: -3}));
  assert.equal(r.window.maxRuns, 1);
  assert.equal(r.window.days, 1);
});

test("a window with no runs does not call the credit hook and still renders", async () => {
  const h = harness({runs: [], jobs: {}});
  let credit = 0;
  const r = await history.analyze(base({fetchImpl: h.fetchImpl, onFirstPage: async () => { credit++; }}));
  assert.equal(credit, 0);
  assert.deepEqual(r.totals, {runs: 0, completed: 0, runnerMinutes: 0, wallClockMinutes: 0});
  const md = history.renderMarkdown(r);
  assert.match(md, /0 runs/);
  assert.match(md, /No finished jobs were read/);
});

test("a job list longer than one page is read in full", async () => {
  const jobs = [];
  for (let i = 0; i < 130; i++) jobs.push(M.job(5000 + i, "shard " + i, "10:00:00", "10:00:10", "10:02:00"));
  const h = harness({runs: [M.run(900, "10:00:00", "10:02:00")], jobs: {900: jobs}});
  const r = await history.analyze(base({fetchImpl: h.fetchImpl}));
  assert.equal(r.totals.runnerMinutes, 130 * 2);
  assert.equal(h.log.filter((x) => x === "jobs:900").length, 2);
  assert.ok(h.calls.some((c) => /jobs\?per_page=100&filter=all&page=2$/.test(c.url)));
});

/* Two attempts. Run 700 failed on attempt 1 and again on attempt 2 (run_started_at is the start of the latest attempt).
 *   attempt 1: build 10:00:30-10:10:30 (600 s -> 10 min, queued 30 s), step "Run tests" 480 s
 *   attempt 2: build 10:21:00-10:25:00 (240 s -> 4 min, queued 60 s), step "Run tests" 120 s
 *  Run 701 (same workflow, branch and event) started 10:22:00: build 10:22:10-10:30:00 (470 s -> 8 min, queued 10 s).
 *  Runner minutes count every attempt: 10 + 4 + 8 = 22. Failure minutes for run 700: 14.
 *  Run 700 ends with its latest attempt at 10:25:00, after 701 started, so it is superseded; its waste is the latest
 *  attempt's build after 10:22:00 = 180 s -> 3 min. Wall clock: 700 = 300 s, 701 = 480 s -> 13 min.
 */
function rerunScenario(extraAttempt1) {
  const a1 = M.job(7001, "build", "10:00:00", "10:00:30", "10:10:30", Object.assign({conclusion: "failure", run_attempt: 1,
    steps: [M.step("Run tests", "10:01:00", "10:09:00")]}, extraAttempt1 || {}));
  const a2 = M.job(7002, "build", "10:20:00", "10:21:00", "10:25:00", {conclusion: "failure", run_attempt: 2,
    steps: [M.step("Run tests", "10:22:00", "10:24:00")]});
  const n = M.job(7011, "build", "10:22:00", "10:22:10", "10:30:00", {run_attempt: 1});
  return {
    runs: [M.run(700, "10:20:00", "10:25:00", {run_attempt: 2, conclusion: "failure"}), M.run(701, "10:22:00", "10:30:00")],
    jobs: {700: [a1, a2], 701: [n]}
  };
}

test("jobs are requested with filter=all so earlier attempts of re-run workflows are returned", async () => {
  const h = harness(rerunScenario());
  await history.analyze(base({fetchImpl: h.fetchImpl}));
  const jobCalls = h.calls.filter((c) => /\/jobs\?/.test(c.url));
  assert.equal(jobCalls.length, 2);
  for (const c of jobCalls) {
    const u = new URL(c.url);
    assert.equal(u.searchParams.get("filter"), "all", c.url);
    assert.equal(u.searchParams.get("per_page"), "100", c.url);
  }
});

test("re-runs: minutes, jobs, steps, queue and failures count every attempt; waste uses the latest attempt", async () => {
  const r = await history.analyze(base({fetchImpl: harness(rerunScenario()).fetchImpl}));
  assert.deepEqual(r.totals, {runs: 2, completed: 2, runnerMinutes: 22, wallClockMinutes: 13});
  assert.deepEqual(r.slowestJobs, [{workflow: "CI", job: "build", runs: 3, medianSeconds: 470, p90Seconds: 600, totalMinutes: 22}]);
  assert.deepEqual(r.slowestSteps, [{workflow: "CI", job: "build", step: "Run tests", runs: 2, totalSeconds: 600, totalMinutes: 10, meanSeconds: 300}]);
  assert.deepEqual(r.queue, [{labels: "ubuntu-latest", jobs: 3, medianSeconds: 30, p90Seconds: 60, flagged: false}]);
  assert.equal(r.failures.failedRuns, 1);
  assert.equal(r.failures.failedMinutes, 14);
  assert.equal(r.failures.rerunRuns, 1);
  assert.equal(r.superseded.runs, 1);
  assert.equal(r.superseded.wasteMinutes, 3);
  assert.deepEqual(r.superseded.byWorkflow, [{workflow: "CI", runs: 2, supersededRuns: 1, wasteMinutes: 3}]);
});

test("re-runs: only the latest attempt decides the run's end time and superseded waste", async () => {
  // An earlier attempt whose job ends long after the latest attempt must not stretch the run or add waste.
  const r = await history.analyze(base({fetchImpl: harness(rerunScenario({completed_at: M.at("10:40:00")})).fetchImpl}));
  assert.equal(r.totals.wallClockMinutes, 13);
  assert.equal(r.superseded.runs, 1);
  assert.equal(r.superseded.wasteMinutes, 3);
  // ... but its minutes still count: 10:00:30-10:40:00 = 2370 s -> 40, plus 4 and 8
  assert.equal(r.totals.runnerMinutes, 52);
});

test("re-runs: the method notes say earlier attempts are included", async () => {
  const r = await history.analyze(base({fetchImpl: harness(rerunScenario()).fetchImpl}));
  assert.ok(r.method.some((m) => /Earlier attempts of re-run workflows are included/.test(m)));
  assert.match(history.renderMarkdown(r), /Earlier attempts of re-run workflows are included/);
});

test("markdown: the superseded headline says 'at most' what cancel-in-progress would have cancelled", async () => {
  const r = await history.analyze(base({fetchImpl: harness(M.scenario()).fetchImpl}));
  const md = history.renderMarkdown(r);
  assert.ok(md.includes(", at most what a `cancel-in-progress` concurrency group would have cancelled (pipelines that must finish every push would cancel less)."), md);
  assert.ok(!md.includes("which is what a `cancel-in-progress`"));
});

test("fork branches with the same name are not treated as one group", async () => {
  const mk = (id, start, end, fork) => M.run(id, start, end, {head_branch: "patch-1", event: "pull_request", head_repository: {id: fork}});
  const runs = [mk(1, "10:00:00", "10:10:00", 7), mk(2, "10:05:00", "10:12:00", 8)];
  const jobs = {1: [M.job(11, "t", "10:00:00", "10:00:10", "10:10:00")], 2: [M.job(21, "t", "10:05:00", "10:05:10", "10:12:00")]};
  let r = await history.analyze(base({fetchImpl: harness({runs, jobs}).fetchImpl}));
  assert.equal(r.superseded.runs, 0);
  runs[1].head_repository.id = 7;                       // same fork: now superseded
  r = await history.analyze(base({fetchImpl: harness({runs, jobs}).fetchImpl}));
  assert.equal(r.superseded.runs, 1);
  assert.equal(r.superseded.wasteMinutes, 5);           // 10:10:00 - 10:05:00
});

test("a newer run that is still in progress supersedes; other events are never grouped", async () => {
  const runs = [
    M.run(1, "10:00:00", "10:10:00", {head_branch: "m"}),
    M.run(2, "10:05:00", "10:05:30", {head_branch: "m", status: "in_progress", conclusion: null}),
    M.run(3, "11:00:00", "11:10:00", {head_branch: "m", event: "schedule"}),
    M.run(4, "11:05:00", "11:12:00", {head_branch: "m", event: "schedule"})
  ];
  const jobs = {1: [M.job(11, "t", "10:00:00", "10:00:10", "10:10:00")], 3: [M.job(31, "t", "11:00:00", "11:00:10", "11:10:00")],
                4: [M.job(41, "t", "11:05:00", "11:05:10", "11:12:00")]};
  const r = await history.analyze(base({fetchImpl: harness({runs, jobs}).fetchImpl}));
  assert.equal(r.superseded.runs, 1);
  assert.equal(r.superseded.wasteMinutes, 5);
});

test("per-job overlap is rounded up per job, not summed first", async () => {
  // newer run starts at 10:05:00; job x ends 10:05:10 (10 s overlap -> 1), job y ends 10:05:20 (20 s -> 1): 2, not ceil(30 s) = 1
  const runs = [M.run(1, "10:00:00", "10:05:20", {head_branch: "m"}), M.run(2, "10:05:00", "10:08:00", {head_branch: "m"})];
  const jobs = {1: [M.job(11, "x", "10:00:00", "10:00:05", "10:05:10"), M.job(12, "y", "10:00:00", "10:00:05", "10:05:20")], 2: []};
  const r = await history.analyze(base({fetchImpl: harness({runs, jobs}).fetchImpl}));
  assert.equal(r.superseded.wasteMinutes, 2);
});

test("a job exactly on a minute boundary is not rounded up", async () => {
  const runs = [M.run(1, "10:00:00", "10:02:00")];
  const jobs = {1: [M.job(11, "x", "10:00:00", "10:00:00", "10:02:00"), M.job(12, "y", "10:00:00", "10:00:00", "10:00:01")]};
  const r = await history.analyze(base({fetchImpl: harness({runs, jobs}).fetchImpl}));
  assert.equal(r.totals.runnerMinutes, 2 + 1);
});

test("bad arguments are typed BAD_ARGS", async () => {
  await assert.rejects(history.analyze(base({owner: "a/b"})), (e) => e.code === "BAD_ARGS");
  await assert.rejects(history.analyze(base({repo: ""})), (e) => e.code === "BAD_ARGS");
  await assert.rejects(history.analyze(undefined), (e) => e.code === "BAD_ARGS");
});

test("now may be a Date, a number or a function", async () => {
  for (const now of [new Date(M.NOW), M.NOW, () => M.NOW]) {
    const r = await history.analyze(base({fetchImpl: harness({runs: [], jobs: {}}).fetchImpl, now}));
    assert.equal(r.window.since, "2026-09-01");
  }
});

test("plain-object response headers (no Headers instance) are understood", async () => {
  const scn = M.scenario();
  const handler = M.makeHandler(scn, {jobsRemaining: () => 3});
  const fetchImpl = async (url, init) => {
    const r = handler(init.method, url);
    return {status: r.status, headers: Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toUpperCase(), v])), json: async () => r.body};
  };
  const r = await history.analyze(base({fetchImpl, concurrency: 1}));
  assert.equal(r.partial, true);
});

/* ---- markdown ---- */

function cellsOf(line) { return line.split(/(?<!\\)\|/).slice(1, -1); }

test("markdown: every table row has as many cells as its header", async () => {
  const r = await history.analyze(base({fetchImpl: harness(M.scenario()).fetchImpl}));
  const md = history.renderMarkdown(r);
  let width = null, rows = 0;
  for (const line of md.split("\n")) {
    if (line.startsWith("|")) {
      const n = cellsOf(line).length;
      if (width === null) width = n;
      assert.equal(n, width, line);
      rows++;
    } else width = null;
  }
  assert.ok(rows > 15);
  assert.match(md, /## CI Speed Check Pro: run history/);
  assert.match(md, /\| Runner minutes \| 35 \|/);
  assert.match(md, /\| Wall-clock minutes \| 29\.7 \|/);
  assert.match(md, /\*\*10 runner minutes\*\*/);
  assert.match(md, /2 runs were already cancelled \(1 of them/);
  assert.match(md, /p90 over 2 min/);
});

test("markdown: minutes only, no currency figures", async () => {
  const r = await history.analyze(base({fetchImpl: harness(M.scenario()).fetchImpl}));
  const md = history.renderMarkdown(r);
  assert.ok(!/\$/.test(md), "no dollar sign");
  assert.ok(!/\b(usd|dollars?|eur|gbp)\b/i.test(md));
  assert.ok(!/[€£¥]/.test(md));
  assert.ok(!/\$/.test(JSON.stringify(r)));
  assert.ok(r.method.some((m) => /No cost figures are computed/.test(m)));
  assert.ok(r.method.some((m) => /rounded up to a whole minute/.test(m) && /bills private repositories/.test(m)));
});

test("markdown: GitHub-derived strings are escaped (pipes, backticks, newlines, angle brackets, links)", async () => {
  const evil = "evil|name`x`\n<script>alert(1)</script> [click](http://example.test)";
  const runs = [
    M.run(1, "10:00:00", "10:05:00", {name: evil, workflow_id: 9, head_branch: evil, status: "completed", conclusion: "failure"}),
    M.run(2, "10:02:00", "10:09:00", {name: evil, workflow_id: 9, head_branch: evil})
  ];
  const jobs = {
    1: [M.job(11, evil, "10:00:00", "10:00:10", "10:05:00", {labels: [evil], steps: [M.step(evil, "10:00:20", "10:04:00")]})],
    2: [M.job(21, evil, "10:02:00", "10:02:10", "10:09:00", {labels: [evil], steps: [M.step(evil, "10:02:20", "10:08:00")]})]
  };
  const r = await history.analyze(base({fetchImpl: harness({runs, jobs}).fetchImpl}));
  const md = history.renderMarkdown(r);
  assert.ok(!/<|>/.test(md), "no angle brackets survive");
  assert.ok(!md.includes("[click]"), "link syntax is defused");
  assert.ok(md.includes("evil\\|name\\`x\\` script"), md);
  let width = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("|")) {
      const n = cellsOf(line).length;
      if (width === null) width = n;
      assert.equal(n, width, line);
    } else width = null;
  }
  assert.ok(!md.split("\n").some((l) => /^(#|-|\*)\s/.test(l) && /evil\|name`x`/.test(l)));
});

test("mdEscape: pipes, backticks and backslashes are escaped; newlines, angle brackets and control characters stripped", () => {
  assert.equal(history.mdEscape("a|b`c\nd<e>"), "a\\|b\\`c de");
  assert.equal(history.mdEscape("back\\slash|"), "back\\\\slash\\|");
  assert.equal(history.mdEscape("x\r\ny z\u0007"), "x y z");
  assert.equal(history.mdEscape(null), "");
  assert.equal(history.mdEscape(undefined), "");
  assert.equal(history.mdEscape(42), "42");
});

test("mdEscape: emphasis characters are escaped", () => {
  assert.equal(history.mdEscape("*bold* _it_ ~~gone~~"), "\\*bold\\* \\_it\\_ \\~\\~gone\\~\\~");
});

test("mdEscape: autolink triggers are broken so report data cannot become a link", () => {
  const out = history.mdEscape("see https://evil.example and www.evil.example");
  assert.ok(!out.includes("://"), out);
  assert.ok(!out.includes("www."), out);
  assert.ok(out.includes(":\u200b//evil.example"), out);
  assert.ok(out.includes("www\u200b.evil.example"), out);
  // every form: start of string, after punctuation, upper case, several URLs
  for (const raw of ["www.a.test", "(www.a.test)", "WWW.a.test", "x\"www.a.test", "ftp://a.test http://b.test"]) {
    const e = history.mdEscape(raw);
    assert.ok(!/:\/\//.test(e) && !/www\./i.test(e), raw + " -> " + e);
  }
  // not a trigger: "www" inside a word stays as is
  assert.equal(history.mdEscape("awww.x"), "awww.x");
  // the visible text is otherwise unchanged
  assert.equal(history.mdEscape("see https://evil.example").replace(/\u200b/g, ""), "see https://evil.example");
});

test("markdown: URLs in GitHub-derived names do not survive as autolinks", async () => {
  const name = "deploy https://evil.example www.evil.example";
  const runs = [M.run(1, "10:00:00", "10:05:00", {name, workflow_id: 9, head_branch: "main", conclusion: "failure"})];
  const jobs = {1: [M.job(11, name, "10:00:00", "10:00:10", "10:05:00", {steps: [M.step(name, "10:00:20", "10:04:00")]})]};
  const md = history.renderMarkdown(await history.analyze(base({fetchImpl: harness({runs, jobs}).fetchImpl})));
  assert.ok(md.includes("evil.example"));
  assert.ok(!md.includes("://"), "no unbroken scheme separator anywhere in the report");
  assert.ok(!/www\./i.test(md));
});

test("fmtDur", () => {
  assert.equal(history.fmtDur(0), "0 s");
  assert.equal(history.fmtDur(45), "45 s");
  assert.equal(history.fmtDur(89), "89 s");
  assert.equal(history.fmtDur(90), "1.5 min");
  assert.equal(history.fmtDur(272), "4.5 min");
  assert.equal(history.fmtDur(NaN), "n/a");
});
