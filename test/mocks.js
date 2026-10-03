"use strict";
// Shared test doubles: a constructed run-history scenario with hand-computed expectations, a request
// handler that serves it, an in-process fetch mock and tiny HTTP servers. Not a test file itself.
const http = require("http");

const p2 = (n) => String(n).padStart(2, "0");
function at(hms, day) {
  const [h, m, s] = hms.split(":").map(Number);
  return (day || "2026-09-30") + "T" + p2(h) + ":" + p2(m) + ":" + p2(s) + "Z";
}

function job(id, name, created, started, completed, o) {
  return Object.assign({
    id, name, status: "completed", conclusion: "success",
    created_at: at(created), started_at: at(started), completed_at: at(completed),
    labels: ["ubuntu-latest"], steps: []
  }, o || {});
}
function step(name, started, completed, o) {
  return Object.assign({name, status: "completed", conclusion: "success", started_at: at(started), completed_at: at(completed)}, o || {});
}
function run(id, started, updated, o) {
  return Object.assign({
    id, name: "CI", workflow_id: 1, head_branch: "main", event: "push", status: "completed", conclusion: "success",
    run_attempt: 1, created_at: at(started), run_started_at: at(started), updated_at: at(updated)
  }, o || {});
}

/* The scenario. Every number below is derived by hand in the comments of test/history.test.js.
 *  CI (workflow 1):  A,B,C on branch feature (pull_request), E,F on branch other (push), G manual, J in progress
 *  Lint (workflow 2): H,I on main (push)
 */
function scenario() {
  const A = run(101, "10:00:00", "10:09:10", {head_branch: "feature", event: "pull_request"});
  const B = run(102, "10:04:00", "10:12:00", {head_branch: "feature", event: "pull_request"});
  const C = run(103, "10:20:00", "10:25:00", {head_branch: "feature", event: "pull_request", conclusion: "failure", run_attempt: 2});
  const E = run(105, "11:00:00", "11:01:10", {head_branch: "other", conclusion: "cancelled"});
  const F = run(106, "11:00:50", "11:03:00", {head_branch: "other"});
  const G = run(107, "13:00:00", "13:00:10", {head_branch: "main", event: "workflow_dispatch", conclusion: "cancelled"});
  const H = run(108, "12:00:00", "12:03:00", {name: "Lint", workflow_id: 2});
  const I = run(109, "12:01:00", "12:02:00", {name: "Lint", workflow_id: 2});
  const J = run(110, "14:00:00", "14:00:05", {head_branch: "late", status: "in_progress", conclusion: null});
  const jobs = {
    101: [
      job(1011, "build", "10:00:00", "10:00:30", "10:09:10", {steps: [
        step("Set up job", "10:00:30", "10:00:35"), step("Run tests", "10:00:40", "10:07:20")]}),
      job(1012, "lint", "10:00:00", "10:00:30", "10:02:00"),
      job(1013, "deploy", "10:02:45", "10:03:00", "10:05:30")
    ],
    102: [
      job(1021, "build", "10:04:00", "10:04:30", "10:12:00", {steps: [step("Run tests", "10:04:40", "10:09:40")]}),
      job(1022, "docs", "10:04:00", "10:12:00", "10:12:00", {conclusion: "skipped"})
    ],
    103: [job(1031, "build", "10:20:00", "10:20:30", "10:25:00", {conclusion: "failure"})],
    105: [job(1051, "build", "11:00:00", "11:00:20", "11:01:10", {conclusion: "cancelled"})],
    106: [job(1061, "build", "11:00:50", "11:01:00", "11:03:00")],
    107: [job(1071, "smoke", "12:57:00", "13:00:00", "13:00:10", {conclusion: "cancelled", labels: ["self-hosted", "linux"]})],
    108: [job(1081, "eslint", "12:00:00", "12:00:10", "12:03:00")],
    109: [job(1091, "eslint", "12:01:00", "12:01:10", "12:02:00")]
  };
  return {runs: [A, B, C, E, F, G, H, I, J], jobs};
}

// Hand-computed results for scenario(); see test/history.test.js for the arithmetic.
const EXPECTED = {
  runs: 9, completed: 8, runnerMinutes: 35, wallClockMinutes: 30,
  supersededRuns: 2, wasteMinutes: 10, cancelled: 2, cancelledBySupersession: 1
};

const NOW = Date.parse("2026-10-01T00:00:00Z");

/* A request handler that serves a scenario. Returns {status, headers, body}. */
function makeHandler(scn, opts) {
  opts = opts || {};
  const log = opts.log || [];
  let jobCalls = 0;
  return function handle(method, rawUrl) {
    const u = new URL(rawUrl, "http://placeholder.invalid");
    if (/\/actions\/runs$/.test(u.pathname)) {
      const page = parseInt(u.searchParams.get("page") || "1", 10);
      log.push("runs:" + page);
      if (opts.runsStatus && opts.runsStatus !== 200) {
        return {status: opts.runsStatus, headers: opts.runsHeaders || {}, body: {message: "nope"}};
      }
      const per = parseInt(u.searchParams.get("per_page") || "30", 10);
      return {
        status: 200,
        headers: {"x-ratelimit-remaining": String(opts.runsRemaining !== undefined ? opts.runsRemaining : 4000)},
        body: {total_count: opts.totalCount !== undefined ? opts.totalCount : scn.runs.length,
               workflow_runs: scn.runs.slice((page - 1) * per, page * per)}
      };
    }
    const m = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
    if (m) {
      const id = parseInt(m[1], 10);
      log.push("jobs:" + id);
      const idx = jobCalls++;
      if (opts.jobsStatus && opts.jobsStatus[id]) {
        return {status: opts.jobsStatus[id], headers: {}, body: {message: "boom"}};
      }
      const all = scn.jobs[id] || [];
      const page = parseInt(u.searchParams.get("page") || "1", 10);
      const per = parseInt(u.searchParams.get("per_page") || "30", 10);
      const rem = opts.jobsRemaining ? opts.jobsRemaining(idx, id) : 4000;
      return {status: 200, headers: {"x-ratelimit-remaining": String(rem)},
              body: {total_count: all.length, jobs: all.slice((page - 1) * per, page * per)}};
    }
    return {status: 404, headers: {}, body: {message: "not found"}};
  };
}

function fetchFrom(handler, calls) {
  return async function fetchImpl(url, init) {
    init = init || {};
    calls.push({url: String(url), method: init.method || "GET", headers: init.headers || {}});
    const r = handler(init.method || "GET", String(url));
    return new Response(JSON.stringify(r.body), {status: r.status, headers: r.headers});
  };
}

/* A tiny HTTP server around a handler(method, url, headers) -> {status, headers, body}. */
function startServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({method: req.method, url: req.url, headers: req.headers});
    const r = handler(req.method, req.url, req.headers);
    res.writeHead(r.status, Object.assign({"content-type": "application/json"}, r.headers || {}));
    res.end(JSON.stringify(r.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port,
        calls,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); })
      });
    });
  });
}

module.exports = {at, job, step, run, scenario, EXPECTED, NOW, makeHandler, fetchFrom, startServer};
