"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawn} = require("child_process");
const M = require("./mocks");
const index = require("../src/index");
const pkg = require("../package.json");

const ENTRY = path.join(__dirname, "..", "src", "index.js");
const KEY = "wk_TESTKEY0123456789abcdefghijkl";
const GH_TOKEN = "ghs_e2eFakeToken000111";
const BUY_URL = "https://weio.ai/services/site-check-api.html";

const BAD = [
  "name: bad",
  "on: [push, pull_request]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "        with:",
  "          fetch-depth: 0",
  "      - uses: some-org/lint-action@v2",
  ""
].join("\n");
const OBS_ONLY = [
  "name: obs", "on: workflow_dispatch", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    timeout-minutes: 5",
  "    steps:", "      - uses: actions/checkout@v4", "        with:", "          fetch-depth: 0", ""
].join("\n");
const CLEAN = ["name: clean", "on: workflow_dispatch", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    timeout-minutes: 5",
  "    steps:", "      - run: echo hi", ""].join("\n");

const cleanups = [];
test.after(() => { for (const f of cleanups) { try { f(); } catch (e) { /* ignore */ } } });

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-e2e-"));
  cleanups.push(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const [rel, text] of Object.entries(files || {".github/workflows/ci.yml": BAD})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, text);
  }
  const tmp = fs.mkdtempSync(path.join(dir, "..", "csc-tmp-"));
  cleanups.push(() => fs.rmSync(tmp, {recursive: true, force: true}));
  return {
    dir, tmp,
    out: path.join(tmp, "output.txt"), summary: path.join(tmp, "summary.md")
  };
}

function run(ws, inputs, extraEnv) {
  const env = {
    PATH: process.env.PATH, HOME: ws.tmp, NODE_NO_WARNINGS: "1",
    GITHUB_WORKSPACE: ws.dir, GITHUB_OUTPUT: ws.out, GITHUB_STEP_SUMMARY: ws.summary, RUNNER_TEMP: ws.tmp,
    GITHUB_REPOSITORY: "acme/widgets"
  };
  for (const [k, v] of Object.entries(inputs || {})) env["INPUT_" + k.toUpperCase()] = v;
  Object.assign(env, extraEnv || {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {env, cwd: ws.tmp});
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("action did not exit within 30 s")); }, 30000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({code, stdout, stderr, lines: stdout.split("\n").filter((l, i, a) => l !== "" || i < a.length - 1),
               summary: fs.existsSync(ws.summary) ? fs.readFileSync(ws.summary, "utf8") : "",
               outputs: parseOutputs(ws.out)});
    });
  });
}

function parseOutputs(file) {
  const res = {};
  if (!fs.existsSync(file)) return res;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^<]+)<<(ghadelimiter_[0-9a-f-]+)$/.exec(lines[i]);
    if (!m) continue;
    const vals = [];
    for (i++; i < lines.length && lines[i] !== m[2]; i++) vals.push(lines[i]);
    res[m[1]] = vals.join("\n");
  }
  return res;
}

const withoutMask = (r) => r.lines.filter((l) => !l.startsWith("::add-mask::"));

// Both mock servers, sharing one ordered log.
async function servers(weioReply, ghOpts) {
  const log = [];
  const scn = M.scenario();
  const gh = await M.startServer((method, url) => M.makeHandler(scn, Object.assign({log}, ghOpts || {}))(method, url));
  const weio = await M.startServer((method, url) => {
    log.push("credit");
    return typeof weioReply === "function" ? weioReply(method, url) : weioReply;
  });
  cleanups.push(() => { gh.close(); weio.close(); });
  return {gh, weio, log, env: {GITHUB_API_URL: gh.url, WEIO_API_BASE: weio.url}};
}
const OK200 = {status: 200, body: {ok: true, credits_remaining: 41}};

/* ------------------------------------------------------------------ free mode */

test("free mode: annotations, summary, outputs, report; nothing leaves the runner", async () => {
  const s = await servers(OK200);
  const ws = workspace();
  const r = await run(ws, {path: ".github/workflows"}, s.env);
  assert.equal(r.code, 0);
  assert.equal(s.gh.calls.length, 0);
  assert.equal(s.weio.calls.length, 0);

  // every line is a workflow command or one of ours: nothing derived from the files can start a command
  for (const l of r.lines) assert.ok(l.startsWith("::") || l.startsWith("ci-speed-check: "), l);
  assert.ok(!r.lines.some((l) => l.startsWith("::add-mask::")));

  const warn = r.lines.filter((l) => l.startsWith("::warning "));
  const note = r.lines.filter((l) => l.startsWith("::notice "));
  assert.equal(warn.length, 3);
  assert.equal(note.length, 1);
  const conc = warn.find((l) => l.includes("no-concurrency-cancel"));
  assert.ok(conc.startsWith("::warning file=.github/workflows/ci.yml,line=2,title=CI Speed Check%3A no-concurrency-cancel::runs on pull_request/push with no top-level concurrency group, so superseded commits keep running and paying%0A%0AFix:%0Aconcurrency:%0A  group: ${{ github.workflow }}-${{ github.ref }}%0A  cancel-in-progress: true"), conc);
  assert.ok(warn.some((l) => l.startsWith("::warning file=.github/workflows/ci.yml,line=4,title=CI Speed Check%3A no-job-timeout::")));
  assert.ok(warn.some((l) => l.startsWith("::warning file=.github/workflows/ci.yml,line=10,title=CI Speed Check%3A unpinned-third-party-action::")));
  assert.ok(note[0].startsWith("::notice file=.github/workflows/ci.yml,line=7,title=CI Speed Check%3A full-history-checkout::"));

  assert.equal(r.outputs.findings, "4");
  assert.equal(r.outputs.defects, "3");
  assert.equal(r.outputs.pro, "false");
  assert.ok(r.outputs.report.startsWith(ws.tmp), "report is written under RUNNER_TEMP");
  const report = JSON.parse(fs.readFileSync(r.outputs.report, "utf8"));
  assert.equal(report.tool, "ci-speed-check");
  assert.equal(report.version, pkg.version);
  assert.deepEqual(report.counts, {findings: 4, defects: 3, observations: 1});
  assert.deepEqual(report.files, [".github/workflows/ci.yml"]);
  assert.deepEqual(report.findings.map((f) => [f.check, f.line, f.class]), [
    ["no-concurrency-cancel", 2, "slowness"], ["no-job-timeout", 4, "hygiene"],
    ["full-history-checkout", 7, "slowness"], ["unpinned-third-party-action", 10, "security"]]);
  assert.ok(report.findings.every((f) => f.fix && f.detail));
  assert.equal(report.pro.requested, false);
  assert.equal(report.pro.history, null);
  assert.equal(report.deviations.length, 3);

  assert.match(r.summary, /^## CI Speed Check/);
  assert.match(r.summary, /\*\*3 defects\*\* and \*\*1 observation\*\*/);
  assert.match(r.summary, /\| File \| Job \| Check \| Class \| Detail \|/);
  assert.match(r.summary, /\| \.github\/workflows\/ci\.yml:4 \| test \| no-job-timeout \| hygiene \|/);
  assert.match(r.summary, /full-history-checkout \(observation\)/);
  assert.match(r.summary, /### Fixes/);
  assert.match(r.summary, /```yaml\nconcurrency:/);
  assert.match(r.summary, /### What this check cannot see/);
  assert.ok(r.summary.includes("Pro: add `api-key`"));
  assert.ok(r.summary.includes(BUY_URL));
  assert.ok(!r.summary.includes("Pro: run history"));
});

test("free mode: a clean repo and an empty workspace", async () => {
  let ws = workspace({".github/workflows/ci.yml": CLEAN});
  let r = await run(ws, {});
  assert.equal(r.code, 0);
  assert.equal(r.outputs.findings, "0");
  assert.match(r.summary, /None of the five rules found anything in the 1 workflow file/);
  assert.equal(r.lines.filter((l) => l.startsWith("::warning")).length, 0);

  ws = workspace({"README.md": "# nothing here"});
  r = await run(ws, {});
  assert.equal(r.code, 0);
  assert.match(r.summary, /No workflow files/);
  assert.equal(r.outputs.findings, "0");
});

test("annotate=false skips annotations but keeps summary, outputs and report", async () => {
  const r = await run(workspace(), {annotate: "false"});
  assert.equal(r.code, 0);
  assert.ok(!r.lines.some((l) => /^::(warning|notice) file=/.test(l)));
  assert.equal(r.outputs.findings, "4");
  assert.match(r.summary, /no-job-timeout/);
});

test("annotations are capped at 10 per level; the summary lists every finding", async () => {
  const jobs = [];
  for (let i = 0; i < 12; i++) jobs.push("  j" + i + ":", "    runs-on: x", "    steps:", "      - run: echo");
  const text = ["on: workflow_dispatch", "jobs:"].concat(jobs, [""]).join("\n");
  const r = await run(workspace({".github/workflows/many.yml": text}), {});
  assert.equal(r.lines.filter((l) => l.startsWith("::warning file=")).length, 10);
  assert.ok(r.lines.some((l) => /^ci-speed-check: 2 more findings are listed/.test(l)));
  assert.equal(r.outputs.findings, "12");
  assert.equal((r.summary.match(/\| no-job-timeout \|/g) || []).length, 12);
});

test("identical findings get their own lines and the fixes are grouped, not repeated per job", async () => {
  const wf = ["on: workflow_dispatch", "jobs:"];
  for (const j of ["a", "b", "c"]) wf.push("  " + j + ":", "    runs-on: x", "    steps:", "      - uses: actions/checkout@v4", "        with:", "          fetch-depth: 0", "      - uses: actions/checkout@v4", "        with:", "          fetch-depth: 0");
  const r = await run(workspace({".github/workflows/dup.yml": wf.concat([""]).join("\n")}), {});
  const report = JSON.parse(fs.readFileSync(r.outputs.report, "utf8"));
  const full = report.findings.filter((f) => f.check === "full-history-checkout").map((f) => f.line);
  assert.deepEqual(full, [6, 9, 15, 18, 24, 27]);
  assert.equal((r.summary.match(/\*\*no-job-timeout\*\*/g) || []).length, 1);
  assert.match(r.summary, /\*\*no-job-timeout\*\* \(3 places: .*\)\. Example, from \.github\/workflows\/dup\.yml:3:/);
  assert.equal((r.summary.match(/\*\*full-history-checkout\*\*/g) || []).length, 1);
});

test("path handling: single file, nested folders, .yaml, symlinks skipped, outside the workspace refused", async () => {
  const ws = workspace({
    "ci/a.yml": BAD, "ci/deep/b.yaml": BAD, "ci/node_modules/skip.yml": BAD, "ci/notes.txt": "x", "other/c.yml": BAD
  });
  fs.writeFileSync(path.join(ws.tmp, "outside.yml"), BAD);
  fs.symlinkSync(path.join(ws.tmp, "outside.yml"), path.join(ws.dir, "ci", "link.yml"));
  let r = await run(ws, {path: "ci"});
  assert.equal(r.outputs.findings, "8");
  assert.deepEqual(JSON.parse(fs.readFileSync(r.outputs.report, "utf8")).files, ["ci/a.yml", "ci/deep/b.yaml"]);
  r = await run(workspace({"ci/a.yml": BAD, "ci/b.yml": CLEAN}), {path: "ci/a.yml"});
  assert.equal(r.outputs.findings, "4");

  r = await run(ws, {path: "../"});
  assert.equal(r.code, 0);
  assert.equal(r.outputs.findings, "0");
  assert.ok(r.lines.some((l) => /^::warning title=CI Speed Check::path must be inside the workspace/.test(l)));

  r = await run(ws, {path: "does/not/exist"});
  assert.equal(r.code, 0);
  assert.equal(r.outputs.findings, "0");
  assert.ok(r.lines.some((l) => /^::warning title=CI Speed Check::path not found: does/.test(l)));
});

test("a YAML error gives one warning for that file and the rest are still checked", async () => {
  const ws = workspace({".github/workflows/broken.yml": "jobs: [unclosed\non: push\n", ".github/workflows/ok.yml": BAD});
  const r = await run(ws, {"fail-on": "none"});
  assert.equal(r.code, 0);
  const w = r.lines.filter((l) => l.startsWith("::warning file=.github/workflows/broken.yml"));
  assert.equal(w.length, 1);
  assert.match(w[0], /could not parse this file as YAML: .*\(line \d+\)\. It was not checked\./);
  assert.equal(r.outputs.findings, "4");
  assert.match(r.summary, /### Files that could not be read\n\n- \.github\/workflows\/broken\.yml: /);
});

test("multi-document files use the first document", async () => {
  const text = CLEAN + "---\n" + BAD;
  const r = await run(workspace({".github/workflows/m.yml": text}), {});
  assert.equal(r.outputs.findings, "0");
});

test("annotation escaping: colons, commas, percent signs and newlines cannot start or split a command", async () => {
  const wf = ["on: workflow_dispatch", "jobs:", '  "a:b,c%d":', "    runs-on: x", '  "line\\nbreak::warning::injected":', "    runs-on: x", ""].join("\n");
  const ws = workspace({".github/workflows/we:ird,name.yml": wf});
  const r = await run(ws, {});
  for (const l of r.lines) assert.ok(l.startsWith("::") || l.startsWith("ci-speed-check: "), l);
  assert.ok(r.lines.some((l) => l.startsWith("::warning file=.github/workflows/we%3Aird%2Cname.yml,line=3,title=CI Speed Check%3A no-job-timeout::job 'a:b,c%25d' has no timeout-minutes")));
  assert.ok(r.lines.some((l) => l.includes("job 'line%0Abreak::warning::injected' has no timeout-minutes")));
  assert.ok(!r.lines.some((l) => l.startsWith("::warning::injected")));
  assert.match(r.summary, /line break::warning::injected/);
});

test("summary escaping: pipes in names do not break the findings table", async () => {
  const wf = ["on: workflow_dispatch", "jobs:", '  "x|y`z":', "    runs-on: x", ""].join("\n");
  const r = await run(workspace({".github/workflows/p.yml": wf}), {});
  const row = r.summary.split("\n").find((l) => l.includes("no-job-timeout") && l.startsWith("|"));
  assert.ok(row.includes("x\\|y\\`z"), row);
  assert.equal(row.split(/(?<!\\)\|/).length, 7);
});

test("the job summary is written even when GITHUB_OUTPUT is unset", async () => {
  const ws = workspace();
  const r = await run(ws, {}, {GITHUB_OUTPUT: ""});
  assert.equal(r.code, 0);
  assert.match(r.summary, /CI Speed Check/);
});

/* ------------------------------------------------------------------ fail-on */

test("fail-on thresholds", async () => {
  const cases = [
    ["defect", BAD, 1], ["defect", OBS_ONLY, 0], ["defect", CLEAN, 0],
    ["any", BAD, 1], ["any", OBS_ONLY, 1], ["any", CLEAN, 0],
    ["none", BAD, 0], ["", BAD, 0], ["DEFECT", BAD, 1]
  ];
  for (const [failOn, wf, code] of cases) {
    const r = await run(workspace({".github/workflows/ci.yml": wf}), {"fail-on": failOn});
    assert.equal(r.code, code, "fail-on=" + failOn + " code " + r.code);
    const err = r.lines.filter((l) => l.startsWith("::error"));
    assert.equal(err.length, code ? 1 : 0);
    // outputs and summary are written before the exit code is decided
    assert.ok(r.outputs.findings !== undefined);
    assert.match(r.summary, /CI Speed Check/);
  }
  const r = await run(workspace(), {"fail-on": "defect"});
  assert.ok(r.lines.includes("::error title=CI Speed Check::fail-on is defect and 3 defects were found."));
  const r2 = await run(workspace({".github/workflows/ci.yml": OBS_ONLY}), {"fail-on": "any"});
  assert.ok(r2.lines.includes("::error title=CI Speed Check::fail-on is any and 1 finding was found."));
});

test("an invalid fail-on value warns and behaves as none", async () => {
  const r = await run(workspace(), {"fail-on": "sometimes"});
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => l.startsWith("::warning title=CI Speed Check::fail-on must be none, defect or any")));
});

/* ------------------------------------------------------------------ Pro */

test("Pro: key masked first, one credit debited after GitHub grants access and before jobs are read", async () => {
  const s = await servers(OK200);
  const ws = workspace();
  const r = await run(ws, {"api-key": KEY, "github-token": GH_TOKEN, repository: "acme/widgets", "history-runs": "50", "history-days": "14"}, s.env);
  assert.equal(r.code, 0);

  // ::add-mask:: is the very first line, and precedes any line that mentions Pro
  assert.equal(r.lines[0], "::add-mask::" + KEY);
  const proIdx = r.lines.findIndex((l, i) => i > 0 && /\bpro\b/i.test(l));
  assert.ok(proIdx > 0, "some line mentions Pro");
  assert.ok(r.lines.findIndex((l) => l.startsWith("::add-mask::")) < proIdx);

  // the key appears nowhere except on the add-mask line
  const rest = withoutMask(r).join("\n");
  assert.ok(!rest.includes(KEY), "stdout");
  assert.ok(!r.stderr.includes(KEY), "stderr");
  assert.ok(!r.summary.includes(KEY), "summary");
  assert.ok(!fs.readFileSync(ws.out, "utf8").includes(KEY), "outputs");
  assert.ok(!fs.readFileSync(r.outputs.report, "utf8").includes(KEY), "report");

  // the credit request
  assert.equal(s.weio.calls.length, 1);
  const c = s.weio.calls[0];
  assert.equal(c.method, "POST");
  const u = new URL(c.url, "http://x");
  assert.equal(u.pathname, "/api/credit");
  assert.equal(u.searchParams.get("for"), "ci-speed-check");
  assert.equal(u.searchParams.get("ref"), "acme/widgets");
  assert.equal(c.headers.authorization, "Bearer " + KEY);
  assert.equal(c.headers["user-agent"], "weio-ci-speed-check/" + pkg.version);

  // the GitHub token goes to the GitHub API base and nowhere else; the Weio key never goes to GitHub
  assert.ok(!JSON.stringify(s.weio.calls).includes(GH_TOKEN));
  assert.ok(s.gh.calls.length >= 9);
  for (const g of s.gh.calls) {
    assert.equal(g.headers.authorization, "Bearer " + GH_TOKEN);
    assert.ok(!JSON.stringify(g).includes(KEY));
  }
  const firstRuns = new URL(s.gh.calls[0].url, "http://x");
  assert.equal(firstRuns.pathname, "/repos/acme/widgets/actions/runs");
  const days14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const days15 = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
  assert.ok([days14, days15].includes(firstRuns.searchParams.get("created").replace(/^>=/, "")), firstRuns.searchParams.get("created"));

  // order: runs list, credit, then jobs
  assert.equal(s.log[0], "runs:1");
  assert.equal(s.log[1], "credit");
  assert.ok(s.log.slice(2).every((x) => x.startsWith("jobs:")));

  assert.equal(r.outputs.pro, "true");
  assert.equal(r.outputs.findings, "4");
  assert.match(r.summary, /## CI Speed Check Pro: run history/);
  assert.match(r.summary, /\| Runner minutes \| 35 \|/);
  assert.match(r.summary, /One Weio credit was used for this run; 41 credits remain on this key\./);
  assert.ok(!r.summary.includes("Pro: add `api-key`"), "no upsell when Pro ran");
  const report = JSON.parse(fs.readFileSync(r.outputs.report, "utf8"));
  assert.equal(report.pro.ran, true);
  assert.equal(report.pro.creditUsed, true);
  assert.equal(report.pro.creditsRemaining, 41);
  assert.equal(report.pro.history.superseded.wasteMinutes, 10);
});

test("Pro: credits_remaining may be absent", async () => {
  const s = await servers({status: 200, body: {ok: true}});
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN}, s.env);
  assert.equal(r.outputs.pro, "true");
  assert.match(r.summary, /One Weio credit was used for this run\./);
  assert.ok(!/credits remain/.test(r.summary));
});

const REJECTIONS = [
  [400, {ok: false, error: "bad parameters"}, /bad parameters/],
  [401, {ok: false, error: "invalid API key", buy: BUY_URL}, /invalid API key/],
  [402, {ok: false, error: "no credits left on this key", buy: BUY_URL}, /no credits left on this key/],
  [402, {ok: false, error: "this key has expired", buy: BUY_URL}, /this key has expired/],
  [429, {ok: false, error: "rate limit exceeded, retry shortly"}, /rate limit exceeded, retry shortly/],
  [500, {ok: false, error: "internal error"}, /internal error/],
  [503, {}, /HTTP 503/]
];
for (const [status, body, re] of REJECTIONS) {
  test("Pro: credit endpoint " + status + " " + JSON.stringify(body.error || "") + " -> warning with the server's text and the buy link, exit 0, no job data read", async () => {
    const s = await servers({status, body});
    const ws = workspace();
    const r = await run(ws, {"api-key": KEY, "github-token": GH_TOKEN}, s.env);
    assert.equal(r.code, 0);
    const w = r.lines.filter((l) => l.startsWith("::warning title=CI Speed Check Pro::"));
    assert.equal(w.length, 1, r.stdout);
    assert.match(w[0], re);
    assert.ok(w[0].includes(BUY_URL));
    assert.ok(w[0].includes("(HTTP " + status + ")"));
    assert.equal(r.outputs.pro, "false");
    assert.equal(r.outputs.findings, "4", "static findings are unaffected");
    assert.deepEqual(s.log, ["runs:1", "credit"], "the runs list was read, the credit refused, no jobs requested");
    assert.match(r.summary, /### Pro: run history\n\nWeio Pro was skipped: /);
    const report = JSON.parse(fs.readFileSync(r.outputs.report, "utf8"));
    assert.equal(report.pro.ran, false);
    assert.equal(report.pro.creditUsed, false);
    assert.match(report.pro.skipped, re);
    assert.ok(!JSON.stringify(report).includes(KEY));
    assert.ok(!withoutMask(r).join("\n").includes(KEY));
  });
}

test("Pro: a rejected credit never fails the job, but fail-on still applies to the static findings", async () => {
  const s = await servers({status: 402, body: {ok: false, error: "no credits left on this key"}});
  let r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN, "fail-on": "defect"}, s.env);
  assert.equal(r.code, 1);
  assert.ok(r.lines.some((l) => l.startsWith("::warning title=CI Speed Check Pro::")));
  assert.ok(r.lines.some((l) => l.startsWith("::error title=CI Speed Check::fail-on is defect")));
  r = await run(workspace({".github/workflows/ci.yml": CLEAN}), {"api-key": KEY, "github-token": GH_TOKEN, "fail-on": "any"}, s.env);
  assert.equal(r.code, 0);
});

test("Pro: server error text that echoes the key is redacted", async () => {
  const s = await servers({status: 401, body: {ok: false, error: "key " + KEY + " is not valid"}});
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN}, s.env);
  assert.equal(r.code, 0);
  const rest = withoutMask(r).join("\n");
  assert.ok(!rest.includes(KEY));
  assert.ok(rest.includes("key *** is not valid"));
  assert.ok(!r.summary.includes(KEY));
});

test("Pro: network failure reaching Weio -> warning, exit 0", async () => {
  const s = await servers(OK200);
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN}, Object.assign({}, s.env, {WEIO_API_BASE: "http://127.0.0.1:1"}));
  assert.equal(r.code, 0);
  const w = r.lines.find((l) => l.startsWith("::warning title=CI Speed Check Pro::"));
  assert.ok(w && /could not reach Weio/.test(w) && w.includes(BUY_URL), w);
  assert.equal(r.outputs.pro, "false");
  assert.deepEqual(s.log, ["runs:1"]);
});

test("Pro: GitHub denies the run list (403) -> no credit call at all, a hint about actions: read, exit 0", async () => {
  const s = await servers(OK200, {runsStatus: 403});
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN}, s.env);
  assert.equal(r.code, 0);
  assert.equal(s.weio.calls.length, 0);
  assert.deepEqual(s.log, ["runs:1"]);
  const w = r.lines.find((l) => l.startsWith("::warning title=CI Speed Check Pro::"));
  assert.ok(/permissions%3A actions%3A read|permissions: actions: read/.test(w) || /permissions: actions: read/.test(w), w);
  assert.ok(w.includes("No credit was used."));
  assert.equal(r.outputs.pro, "false");
});

test("Pro: an invalid key format is masked, never sent anywhere, and skips Pro", async () => {
  const s = await servers(OK200);
  const r = await run(workspace(), {"api-key": "not-a-key-but-secret-text", "github-token": GH_TOKEN}, s.env);
  assert.equal(r.code, 0);
  assert.equal(r.lines[0], "::add-mask::not-a-key-but-secret-text");
  assert.equal(s.weio.calls.length, 0);
  assert.equal(s.gh.calls.length, 0);
  const rest = withoutMask(r).join("\n");
  assert.ok(!rest.includes("not-a-key-but-secret-text"));
  assert.match(rest, /does not look like a Weio API key/);
  assert.equal(r.outputs.pro, "false");
});

test("Pro: a repository that is not owner/name skips Pro without any request", async () => {
  const s = await servers(OK200);
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN, repository: "../../etc"}, s.env);
  assert.equal(r.code, 0);
  assert.equal(s.weio.calls.length + s.gh.calls.length, 0);
  assert.ok(r.lines.some((l) => /^::warning title=CI Speed Check Pro::Weio Pro was skipped: the repository input is not in owner\/repo form/.test(l)));
});

test("Pro: a non-https Weio base is refused so the key is never sent in clear text", async () => {
  const s = await servers(OK200);
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN}, Object.assign({}, s.env, {WEIO_API_BASE: "http://weio.example.test"}));
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => /WEIO_API_BASE must be an https URL/.test(l)));
  assert.equal(s.weio.calls.length, 0);
});

test("Pro: an empty run window uses no credit", async () => {
  const log = [];
  const gh = await M.startServer(M.makeHandler({runs: [], jobs: {}}, {log}));
  const weio = await M.startServer(() => { log.push("credit"); return OK200; });
  cleanups.push(() => { gh.close(); weio.close(); });
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN}, {GITHUB_API_URL: gh.url, WEIO_API_BASE: weio.url});
  assert.equal(r.code, 0);
  assert.deepEqual(log, ["runs:1"]);
  assert.equal(r.outputs.pro, "true");
  assert.match(r.summary, /The run window held no runs, so no credit was used\./);
});

test("Pro: the repository input defaults to GITHUB_REPOSITORY", async () => {
  const s = await servers(OK200);
  const r = await run(workspace(), {"api-key": KEY, "github-token": GH_TOKEN}, Object.assign({}, s.env, {GITHUB_REPOSITORY: "octo/repo"}));
  assert.equal(r.code, 0);
  assert.equal(new URL(s.weio.calls[0].url, "http://x").searchParams.get("ref"), "octo/repo");
  assert.equal(new URL(s.gh.calls[0].url, "http://x").pathname, "/repos/octo/repo/actions/runs");
});

/* ------------------------------------------------------------------ toolkit pieces */

test("toolkit escaping matches @actions/core", () => {
  assert.equal(index.escapeData("a%b\r\nc:d,e"), "a%25b%0D%0Ac:d,e");
  assert.equal(index.escapeProperty("a%b\r\nc:d,e"), "a%25b%0D%0Ac%3Ad%2Ce");
  assert.equal(index.formatCommand("warning", {file: "a:b,c.yml", line: 3, title: "t"}, "m%\n"), "::warning file=a%3Ab%2Cc.yml,line=3,title=t::m%25%0A");
  assert.equal(index.formatCommand("add-mask", {}, "secret"), "::add-mask::secret");
  assert.equal(index.formatCommand("notice", {file: undefined, line: "", title: "x"}, "m"), "::notice title=x::m");
});

test("getInput reads INPUT_<NAME> with hyphens kept and spaces turned into underscores", () => {
  const env = {"INPUT_FAIL-ON": " defect ", INPUT_PATH: "p", "INPUT_MY_INPUT": "v"};
  assert.equal(index.getInput("fail-on", env), "defect");
  assert.equal(index.getInput("path", env), "p");
  assert.equal(index.getInput("my input", env), "v");
  assert.equal(index.getInput("absent", env), "");
});

test("setOutput appends heredoc-delimited values with a random delimiter", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csc-out-")), "o.txt");
  cleanups.push(() => fs.rmSync(path.dirname(file), {recursive: true, force: true}));
  index.setOutput("a", "1", {GITHUB_OUTPUT: file});
  index.setOutput("b", "line1\nline2", {GITHUB_OUTPUT: file});
  const text = fs.readFileSync(file, "utf8");
  const delims = text.match(/ghadelimiter_[0-9a-f-]{36}/g);
  assert.equal(delims.length, 4);
  assert.notEqual(delims[0], delims[2]);
  assert.deepEqual(parseOutputs(file), {a: "1", b: "line1\nline2"});
  index.setOutput("c", "x", {});   // no GITHUB_OUTPUT: no throw
});
