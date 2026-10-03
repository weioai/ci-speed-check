"use strict";
/* CI Speed Check Pro: reads a repository's GitHub Actions run history and turns it into minutes-only findings.
 *
 * No GitHub-Actions-specific I/O lives here (no env, no files, no stdout), so a VS Code extension can reuse it.
 * Everything that touches the outside world is injected: fetchImpl, apiBase, now, onFirstPage.
 *
 *   analyze({owner, repo, token, maxRuns, days, fetchImpl, apiBase, now, onFirstPage}) -> report
 *   renderMarkdown(report) -> string
 *
 * Minutes only. This module never computes a currency figure.
 */

var DEFAULT_API_BASE = "https://api.github.com";
var MAX_RUNS = 300;
var DEFAULT_RUNS = 100;
var DEFAULT_DAYS = 30;
var RATE_LIMIT_FLOOR = 20;       // stop early when x-ratelimit-remaining drops below this
var QUEUE_FLAG_SECONDS = 120;    // flag a runner label set whose p90 queue time exceeds this
var REQUEST_TIMEOUT_MS = 30000;
var MAX_JOB_PAGES = 5;
var SUPERSEDED_EVENTS = ["push", "pull_request"];
var FAILED_CONCLUSIONS = ["failure", "timed_out", "startup_failure"];

class HistoryError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "HistoryError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/* ------------------------------------------------------------- helpers */

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function toInt(v, dflt) { var n = parseInt(v, 10); return isFinite(n) ? n : dflt; }
function tsMs(s) { return typeof s === "string" ? Date.parse(s) : NaN; }
function fin(n) { return typeof n === "number" && isFinite(n); }
function ceilMin(ms) { return fin(ms) && ms > 0 ? Math.ceil(ms / 60000) : 0; }
function round1(n) { return Math.round(n * 10) / 10; }
function str(v, dflt) { return typeof v === "string" && v ? v : (dflt === undefined ? "" : dflt); }
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

function median(sorted) {
  var n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
function percentile(sorted, p) {   // nearest rank
  var n = sorted.length;
  if (!n) return 0;
  return sorted[clamp(Math.ceil(p * n) - 1, 0, n - 1)];
}
function sortNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }

function resolveNow(now) {
  var v = typeof now === "function" ? now() : now;
  if (v instanceof Date) v = v.getTime();
  return fin(v) ? v : Date.now();
}

function getHeader(res, name) {
  var h = res && res.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  var lower = name.toLowerCase();
  for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === lower) return h[k];
  return null;
}

// Strings from GitHub (workflow, job, step and branch names) go into markdown tables. Strip newlines and
// angle brackets, escape the characters that change meaning in a table cell.
function mdEscape(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/[|`\[\]]/g, "\\$&");
}

function fmtDur(sec) {
  if (!fin(sec)) return "n/a";
  if (sec < 90) return Math.round(sec) + " s";
  return round1(sec / 60) + " min";
}

/* ------------------------------------------------------------- analyze */

async function analyze(opts) {
  opts = opts || {};
  var owner = opts.owner, repo = opts.repo, token = opts.token;
  var okName = /^[A-Za-z0-9_.-]+$/;
  if (typeof owner !== "string" || typeof repo !== "string" || !okName.test(owner) || !okName.test(repo)) {
    throw new HistoryError("BAD_ARGS", "owner and repo must be plain GitHub names");
  }
  var f = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof f !== "function") throw new HistoryError("BAD_ARGS", "no fetch implementation available");
  var apiBase = String(opts.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  var maxRuns = clamp(toInt(opts.maxRuns, DEFAULT_RUNS), 1, MAX_RUNS);
  var days = clamp(toInt(opts.days, DEFAULT_DAYS), 1, 365);
  var concurrency = clamp(toInt(opts.concurrency, 4), 1, 8);
  var nowMs = resolveNow(opts.now);
  var since = isoDate(nowMs - days * 86400000);
  var slug = owner + "/" + repo;

  var headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "weio-ci-speed-check"
  };
  if (token) headers["Authorization"] = "Bearer " + token;

  var state = {remaining: null, partial: false, reason: null};
  function lowRate() { return state.remaining !== null && state.remaining < RATE_LIMIT_FLOOR; }
  function markPartial(reason) { if (!state.partial) { state.partial = true; state.reason = reason; } }

  // One GET. Returns {status, ok, body, rateLimited}; throws only on network failure or timeout.
  async function get(url) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    if (timer && timer.unref) timer.unref();
    try {
      var res = await f(url, {method: "GET", headers: headers, signal: ctl ? ctl.signal : undefined});
      var body = null;
      try { body = typeof res.json === "function" ? await res.json() : null; } catch (e) { body = null; }
      var rem = parseInt(getHeader(res, "x-ratelimit-remaining"), 10);
      if (isFinite(rem)) state.remaining = rem;
      var status = res.status;
      var retryAfter = getHeader(res, "retry-after");
      return {
        status: status,
        ok: status >= 200 && status < 300,
        body: body,
        rateLimited: status === 429 || (status === 403 && (rem === 0 || retryAfter !== null))
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ---- 1. runs list */
  var runs = [], seen = Object.create(null), totalCount = null, page = 1, firstPageDone = false;
  while (runs.length < maxRuns && page <= 10) {
    if (page > 1 && lowRate()) { markPartial("GitHub rate limit nearly used up while listing runs"); break; }
    var url = apiBase + "/repos/" + owner + "/" + repo + "/actions/runs?per_page=100&created=" +
              encodeURIComponent(">=" + since) + "&page=" + page;
    var r;
    try {
      r = await get(url);
    } catch (e) {
      if (page === 1) throw new HistoryError("GITHUB_ERROR", "could not reach the GitHub API: " + (e && e.name === "AbortError" ? "timed out" : "network error"));
      markPartial("could not read page " + page + " of the run list");
      break;
    }
    if (!r.ok) {
      if (page === 1) {
        if (r.rateLimited) throw new HistoryError("RATE_LIMITED", "GitHub rate limit reached (HTTP " + r.status + "); try again later", r.status);
        if (r.status === 401 || r.status === 403 || r.status === 404) {
          throw new HistoryError("NO_ACCESS", "GitHub did not allow reading the run history of " + slug + " (HTTP " + r.status +
            "). Grant the job read access to workflow runs with \"permissions: actions: read\" (keep \"contents: read\"), " +
            "and make sure github-token can see this repository.", r.status);
        }
        throw new HistoryError("GITHUB_ERROR", "GitHub returned HTTP " + r.status + " for the run list", r.status);
      }
      markPartial("could not read page " + page + " of the run list (HTTP " + r.status + ")");
      break;
    }
    var batch = r.body && Array.isArray(r.body.workflow_runs) ? r.body.workflow_runs : [];
    if (r.body && fin(r.body.total_count)) totalCount = r.body.total_count;
    if (page === 1 && !firstPageDone) {
      firstPageDone = true;
      // The caller debits its credit here: after GitHub has granted access, before any job data is read.
      // An empty window has nothing to report, so nothing is charged for it.
      if (batch.length && typeof opts.onFirstPage === "function") await opts.onFirstPage({runs: batch.length});
    }
    for (var i = 0; i < batch.length && runs.length < maxRuns; i++) {
      var run = batch[i];
      if (!run || typeof run !== "object" || seen[run.id]) continue;
      seen[run.id] = true;
      runs.push(run);
    }
    if (batch.length < 100) break;
    page++;
  }
  var sampleLimited = totalCount !== null && totalCount > runs.length && runs.length >= maxRuns;

  /* ---- 2. jobs for completed runs */
  var completed = runs.filter(function (x) { return x.status === "completed"; });
  var jobsByRun = Object.create(null);
  var jobsRead = 0, jobsFailed = 0, nextIdx = 0, stopped = false;

  async function readJobs(run) {
    var all = [], p = 1;
    while (p <= MAX_JOB_PAGES) {
      var u = apiBase + "/repos/" + owner + "/" + repo + "/actions/runs/" + run.id + "/jobs?per_page=100" + (p > 1 ? "&page=" + p : "");
      var jr = await get(u);
      if (!jr.ok) return {error: jr};
      var js = jr.body && Array.isArray(jr.body.jobs) ? jr.body.jobs : [];
      all = all.concat(js);
      var total = jr.body && fin(jr.body.total_count) ? jr.body.total_count : all.length;
      if (js.length < 100 || all.length >= total) break;
      p++;
    }
    return {jobs: all};
  }
  async function worker() {
    while (!stopped) {
      var idx = nextIdx++;
      if (idx >= completed.length) return;
      if (lowRate()) {
        stopped = true;
        markPartial("GitHub rate limit nearly used up (fewer than " + RATE_LIMIT_FLOOR + " requests left)");
        return;
      }
      var run = completed[idx], out;
      try { out = await readJobs(run); } catch (e) { jobsFailed++; continue; }
      if (out.error) {
        if (out.error.rateLimited) {
          stopped = true;
          markPartial("GitHub rate limit reached (HTTP " + out.error.status + ")");
          return;
        }
        jobsFailed++;
        continue;
      }
      jobsByRun[run.id] = out.jobs;
      jobsRead++;
    }
  }
  var workers = [];
  for (var w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  var unread = completed.length - jobsRead - jobsFailed;
  var report = buildReport({
    slug: slug, runs: runs, completed: completed, jobsByRun: jobsByRun, since: since, days: days,
    maxRuns: maxRuns, nowMs: nowMs, totalCount: totalCount, sampleLimited: sampleLimited,
    jobsFailed: jobsFailed, unread: Math.max(0, unread), partial: state.partial, reason: state.reason
  });
  return report;
}

/* ------------------------------------------------------------- compute */

function normJob(j) {
  var s = tsMs(j && j.started_at), e = tsMs(j && j.completed_at), c = tsMs(j && j.created_at);
  var skipped = !!j && j.conclusion === "skipped";
  var durMs = fin(s) && fin(e) ? Math.max(0, e - s) : null;
  var labels = Array.isArray(j && j.labels) ? j.labels.map(String).sort() : [];
  var steps = (Array.isArray(j && j.steps) ? j.steps : []).map(function (st) {
    var a = tsMs(st && st.started_at), b = tsMs(st && st.completed_at);
    return {
      name: str(st && st.name, "(unnamed step)"),
      ms: fin(a) && fin(b) && st.conclusion !== "skipped" ? Math.max(0, b - a) : null
    };
  });
  return {
    name: str(j && j.name, "(unnamed job)"), labels: labels, createdMs: c, startMs: s, endMs: e,
    durMs: durMs, skipped: skipped, minutes: skipped ? 0 : ceilMin(durMs), steps: steps
  };
}

function buildReport(c) {
  var wfNames = Object.create(null);
  var info = c.runs.map(function (r) {
    var wfId = r.workflow_id !== undefined && r.workflow_id !== null ? String(r.workflow_id) : "?";
    var nm = str(r.name) || (typeof r.path === "string" ? r.path.split("/").pop() : "") || ("workflow " + wfId);
    if (!wfNames[wfId]) wfNames[wfId] = nm;
    var jobs = (c.jobsByRun[r.id] || []).map(normJob);
    var startMs = tsMs(r.run_started_at);
    if (!fin(startMs)) startMs = tsMs(r.created_at);
    var jobEnds = jobs.filter(function (j) { return !j.skipped && fin(j.endMs); }).map(function (j) { return j.endMs; });
    var endMs = jobEnds.length ? Math.max.apply(null, jobEnds) : tsMs(r.updated_at);
    var completed = r.status === "completed";
    return {
      run: r, id: r.id, wfId: wfId, wf: nm, event: r.event, branch: r.head_branch,
      fork: r.head_repository && r.head_repository.id !== undefined ? String(r.head_repository.id) : "",
      completed: completed, conclusion: r.conclusion, attempt: toInt(r.run_attempt, 1),
      startMs: startMs, endMs: endMs, jobs: jobs, hasJobs: !!c.jobsByRun[r.id],
      minutes: jobs.reduce(function (a, j) { return a + j.minutes; }, 0)
    };
  });
  // Use one display name per workflow id so tables do not split on a renamed workflow.
  info.forEach(function (x) { x.wf = wfNames[x.wfId] || x.wf; });
  var done = info.filter(function (x) { return x.completed; });

  /* totals */
  var runnerMinutes = 0, wallMs = 0;
  done.forEach(function (x) {
    runnerMinutes += x.minutes;
    if (fin(x.startMs) && fin(x.endMs) && x.endMs > x.startMs) wallMs += x.endMs - x.startMs;
  });

  /* superseded runs: group by workflow, branch, event (forks kept apart), push and pull_request only */
  var groups = Object.create(null);
  info.forEach(function (x) {
    if (SUPERSEDED_EVENTS.indexOf(x.event) < 0 || !fin(x.startMs)) return;
    var key = [x.wfId, x.branch, x.event, x.fork].join("\u0000");
    (groups[key] = groups[key] || []).push(x);
  });
  var cancelledAll = done.filter(function (x) { return x.conclusion === "cancelled"; }).length;
  var cancelledSuperseded = 0, supersededRuns = 0, wasteMinutes = 0;
  var byWf = Object.create(null);
  Object.keys(groups).forEach(function (key) {
    var g = groups[key].slice().sort(function (a, b) { return a.startMs - b.startMs || a.id - b.id; });
    for (var i = 0; i + 1 < g.length; i++) {
      var R = g[i], N = g[i + 1];
      if (!R.completed || !fin(R.endMs) || !(N.startMs < R.endMs)) continue;
      if (R.conclusion === "cancelled") { cancelledSuperseded++; continue; }
      if (!R.hasJobs) continue;   // no job data (partial read): cannot measure its waste
      var waste = 0;
      R.jobs.forEach(function (j) {
        if (j.skipped || !fin(j.startMs) || !fin(j.endMs)) return;
        waste += ceilMin(j.endMs - Math.max(j.startMs, N.startMs));
      });
      supersededRuns++;
      wasteMinutes += waste;
      var b = byWf[R.wfId] = byWf[R.wfId] || {workflow: R.wf, supersededRuns: 0, wasteMinutes: 0};
      b.supersededRuns++;
      b.wasteMinutes += waste;
    }
  });
  var runsPerWf = Object.create(null);
  info.forEach(function (x) { runsPerWf[x.wfId] = (runsPerWf[x.wfId] || 0) + 1; });
  var supersededByWorkflow = Object.keys(byWf).map(function (id) {
    var b = byWf[id];
    return {workflow: b.workflow, runs: runsPerWf[id] || 0, supersededRuns: b.supersededRuns, wasteMinutes: b.wasteMinutes};
  }).sort(function (a, b) {
    return b.wasteMinutes - a.wasteMinutes || b.supersededRuns - a.supersededRuns || (a.workflow < b.workflow ? -1 : 1);
  }).slice(0, 5);

  /* slowest jobs, slowest steps, queue time */
  var jobAgg = Object.create(null), stepAgg = Object.create(null), qAgg = Object.create(null);
  done.forEach(function (x) {
    x.jobs.forEach(function (j) {
      if (j.skipped) return;
      if (j.durMs !== null) {
        var jk = x.wf + "\u0000" + j.name;
        var a = jobAgg[jk] = jobAgg[jk] || {workflow: x.wf, job: j.name, secs: [], totalMinutes: 0};
        a.secs.push(j.durMs / 1000);
        a.totalMinutes += j.minutes;
        j.steps.forEach(function (st) {
          if (st.ms === null) return;
          var sk = jk + "\u0000" + st.name;
          var s = stepAgg[sk] = stepAgg[sk] || {workflow: x.wf, job: j.name, step: st.name, runs: 0, totalSec: 0};
          s.runs++;
          s.totalSec += st.ms / 1000;
        });
      }
      if (fin(j.createdMs) && fin(j.startMs)) {
        var lk = j.labels.length ? j.labels.join(", ") : "(no labels)";
        (qAgg[lk] = qAgg[lk] || []).push(Math.max(0, (j.startMs - j.createdMs) / 1000));
      }
    });
  });
  var slowestJobs = Object.keys(jobAgg).map(function (k) {
    var a = jobAgg[k], s = sortNum(a.secs);
    return {workflow: a.workflow, job: a.job, runs: s.length, medianSeconds: Math.round(median(s)),
            p90Seconds: Math.round(percentile(s, 0.9)), totalMinutes: a.totalMinutes};
  }).sort(function (a, b) {
    return b.totalMinutes - a.totalMinutes || b.medianSeconds - a.medianSeconds ||
           (a.workflow + a.job < b.workflow + b.job ? -1 : 1);
  }).slice(0, 10);
  var slowestSteps = Object.keys(stepAgg).map(function (k) {
    var s = stepAgg[k];
    return {workflow: s.workflow, job: s.job, step: s.step, runs: s.runs,
            totalSeconds: Math.round(s.totalSec), totalMinutes: round1(s.totalSec / 60),
            meanSeconds: Math.round(s.totalSec / s.runs)};
  }).sort(function (a, b) {
    return b.totalSeconds - a.totalSeconds || (a.workflow + a.job + a.step < b.workflow + b.job + b.step ? -1 : 1);
  }).slice(0, 10);
  var queue = Object.keys(qAgg).map(function (k) {
    var s = sortNum(qAgg[k]), p90 = percentile(s, 0.9);
    return {labels: k, jobs: s.length, medianSeconds: Math.round(median(s)), p90Seconds: Math.round(p90),
            flagged: p90 > QUEUE_FLAG_SECONDS};
  }).sort(function (a, b) { return b.p90Seconds - a.p90Seconds || (a.labels < b.labels ? -1 : 1); }).slice(0, 10);

  /* failures */
  var fAgg = Object.create(null), failedRuns = 0, failedMinutes = 0;
  done.forEach(function (x) {
    var a = fAgg[x.wfId] = fAgg[x.wfId] || {workflow: x.wf, completed: 0, failed: 0, failedMinutes: 0};
    a.completed++;
    if (FAILED_CONCLUSIONS.indexOf(x.conclusion) >= 0) {
      a.failed++;
      a.failedMinutes += x.minutes;
      failedRuns++;
      failedMinutes += x.minutes;
    }
  });
  var failureByWorkflow = Object.keys(fAgg).map(function (k) {
    var a = fAgg[k];
    return {workflow: a.workflow, completed: a.completed, failed: a.failed,
            failureRatePercent: a.completed ? round1(100 * a.failed / a.completed) : 0,
            failedMinutes: a.failedMinutes};
  }).sort(function (a, b) {
    return b.failedMinutes - a.failedMinutes || b.failed - a.failed || (a.workflow < b.workflow ? -1 : 1);
  });
  var rerunRuns = info.filter(function (x) { return x.attempt > 1; }).length;

  var method = [
    "Sample: " + info.length + " run" + (info.length === 1 ? "" : "s") + " created since " + c.since + " (a " + c.days +
      "-day window, limit " + c.maxRuns + " runs); " + done.length + " completed." +
      (c.sampleLimited ? " The window holds " + c.totalCount + " runs, so the oldest were left out." : ""),
    "Minutes only. No cost figures are computed. Runner minutes are the sum of each job's duration rounded up " +
      "to a whole minute, which is how GitHub bills private repositories; public repositories on GitHub-hosted " +
      "runners are not billed. Windows and macOS multipliers, included minutes and larger-runner rates are not applied.",
    "Superseded: a completed, not cancelled run counts as superseded when a newer run of the same workflow, " +
      "branch and event (push or pull_request) started before it finished. Its waste is the runner time of its " +
      "jobs after that newer run started, each job rounded up to a whole minute. It is an upper bound on what a " +
      "cancel-in-progress concurrency group would have cancelled, since some pipelines intend every push to finish.",
    "Medians and p90 use job and step timestamps from GitHub (p90 is nearest rank). Queue time is a job's " +
      "created_at to started_at. Jobs GitHub skipped are left out of job, step and queue figures.",
    "Failures are runs that ended in failure, timed_out or startup_failure. Wall-clock minutes run from a run's " +
      "start to its last job finishing, summed over completed runs."
  ];
  if (c.jobsFailed) method.push(c.jobsFailed + " completed run" + (c.jobsFailed === 1 ? "" : "s") +
    " could not have their jobs read and count only in the run totals.");
  if (c.partial) method.push("Partial report: " + c.reason + ". " + c.unread + " completed run" +
    (c.unread === 1 ? " was" : "s were") + " not read, so job, step, queue and waste figures cover only the runs read.");

  return {
    repo: c.slug,
    generatedAt: new Date(c.nowMs).toISOString(),
    window: {days: c.days, since: c.since, maxRuns: c.maxRuns, totalRunsInWindow: c.totalCount},
    partial: !!c.partial,
    partialReason: c.partial ? c.reason : null,
    totals: {
      runs: info.length,
      completed: done.length,
      runnerMinutes: runnerMinutes,
      wallClockMinutes: round1(wallMs / 60000)
    },
    superseded: {
      runs: supersededRuns,
      wasteMinutes: wasteMinutes,
      wastePercentOfRunnerMinutes: runnerMinutes ? round1(100 * wasteMinutes / runnerMinutes) : 0,
      cancelled: cancelledAll,
      cancelledBySupersession: cancelledSuperseded,
      byWorkflow: supersededByWorkflow
    },
    slowestJobs: slowestJobs,
    slowestSteps: slowestSteps,
    queue: queue,
    failures: {failedRuns: failedRuns, failedMinutes: failedMinutes, rerunRuns: rerunRuns, byWorkflow: failureByWorkflow},
    method: method
  };
}

/* ------------------------------------------------------------ markdown */

function table(headers, rows) {
  var out = ["| " + headers.join(" | ") + " |", "|" + headers.map(function () { return " --- "; }).join("|") + "|"];
  rows.forEach(function (r) { out.push("| " + r.join(" | ") + " |"); });
  return out.join("\n");
}
function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

function renderMarkdown(report) {
  var r = report, t = r.totals, s = r.superseded, E = mdEscape, out = [];
  out.push("## CI Speed Check Pro: run history");
  out.push("");
  out.push("Repository " + E(r.repo) + ". " + plural(t.runs, "run") + " created since " + E(r.window.since) + " (" +
           plural(r.window.days, "day") + ", limit " + r.window.maxRuns + " runs), " + t.completed + " completed." +
           (r.partial ? " **Partial report:** " + E(r.partialReason) + "." : ""));
  out.push("");
  out.push("### Totals");
  out.push("");
  out.push(table(["Measure", "Minutes or count"], [
    ["Runs analysed", String(t.runs)],
    ["Completed runs", String(t.completed)],
    ["Runner minutes", String(t.runnerMinutes)],
    ["Wall-clock minutes", String(t.wallClockMinutes)]
  ]));
  out.push("");
  out.push("Runner minutes add up each job's duration, rounded up to a whole minute, the way GitHub bills private " +
           "repositories. Wall-clock minutes run from each run's start to its last job finishing.");
  out.push("");

  out.push("### Runs superseded by a newer run");
  out.push("");
  if (s.runs === 0) {
    out.push("No completed run was still running when a newer run of the same workflow, branch and event had started.");
  } else {
    out.push(plural(s.runs, "run was", "runs were") + " still running after a newer run of the same workflow, branch and " +
             "event had started. Their jobs spent **" + s.wasteMinutes + " runner minutes** after that point" +
             (t.runnerMinutes ? " (" + s.wastePercentOfRunnerMinutes + "% of the runner minutes in this sample)" : "") +
             ", which is what a `cancel-in-progress` concurrency group would have cancelled.");
    out.push("");
    out.push(table(["Workflow", "Runs in sample", "Superseded runs", "Runner minutes after newer run started"],
      s.byWorkflow.map(function (b) { return [E(b.workflow), String(b.runs), String(b.supersededRuns), String(b.wasteMinutes)]; })));
  }
  out.push("");
  out.push(plural(s.cancelled, "run was", "runs were") + " already cancelled" +
           (s.cancelled ? " (" + s.cancelledBySupersession + " of them with a newer run already started, which is concurrency doing its job)" : "") +
           "; cancelled runs are not counted as superseded waste.");
  out.push("");

  out.push("### Slowest jobs");
  out.push("");
  if (r.slowestJobs.length) {
    out.push(table(["Workflow", "Job", "Runs", "Median", "p90", "Total minutes"],
      r.slowestJobs.map(function (j) {
        return [E(j.workflow), E(j.job), String(j.runs), fmtDur(j.medianSeconds), fmtDur(j.p90Seconds), String(j.totalMinutes)];
      })));
    out.push("");
    out.push("Top 10 by total minutes (each job rounded up to a whole minute).");
  } else out.push("No finished jobs were read.");
  out.push("");

  out.push("### Slowest steps");
  out.push("");
  if (r.slowestSteps.length) {
    out.push(table(["Workflow", "Job", "Step", "Runs", "Mean", "Total time"],
      r.slowestSteps.map(function (x) {
        return [E(x.workflow), E(x.job), E(x.step), String(x.runs), fmtDur(x.meanSeconds), fmtDur(x.totalSeconds)];
      })));
    out.push("");
    out.push("Top 10 by total step time.");
  } else out.push("No step timings were read.");
  out.push("");

  out.push("### Queue time");
  out.push("");
  if (r.queue.length) {
    out.push(table(["Runner labels", "Jobs", "Median wait", "p90 wait", "Flag"],
      r.queue.map(function (q) {
        return [E(q.labels), String(q.jobs), fmtDur(q.medianSeconds), fmtDur(q.p90Seconds), q.flagged ? "p90 over 2 min" : ""];
      })));
    out.push("");
    out.push("Wait is the time from a job being created to a runner starting it.");
  } else out.push("No queue timings were read.");
  out.push("");

  out.push("### Failures and re-runs");
  out.push("");
  var f = r.failures;
  out.push(plural(f.failedRuns, "completed run") + " failed, using " + f.failedMinutes + " runner minutes. " +
           plural(f.rerunRuns, "run") + " in the sample " + (f.rerunRuns === 1 ? "was" : "were") + " re-run (attempt 2 or later).");
  var failing = f.byWorkflow.filter(function (x) { return x.failed > 0; });
  if (failing.length) {
    out.push("");
    out.push(table(["Workflow", "Completed runs", "Failed", "Failure rate", "Minutes on failed runs"],
      failing.slice(0, 10).map(function (x) {
        return [E(x.workflow), String(x.completed), String(x.failed), x.failureRatePercent + "%", String(x.failedMinutes)];
      })));
    if (failing.length > 10) out.push("\n" + (failing.length - 10) + " more workflows had failures.");
  }
  out.push("");

  out.push("### How this was measured");
  out.push("");
  r.method.forEach(function (m) { out.push("- " + E(m)); });
  out.push("");
  return out.join("\n");
}

module.exports = {
  analyze: analyze,
  renderMarkdown: renderMarkdown,
  mdEscape: mdEscape,
  fmtDur: fmtDur,
  HistoryError: HistoryError,
  MAX_RUNS: MAX_RUNS,
  RATE_LIMIT_FLOOR: RATE_LIMIT_FLOOR
};
