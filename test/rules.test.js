"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const yaml = require("../src/vendor/js-yaml.min.js");
const rules = require("../src/rules");
const reference = require("./reference/ci_check.js");

const FIXTURES = path.join(__dirname, "fixtures");
const fixtureNames = fs.readdirSync(FIXTURES).filter((f) => /\.ya?ml$/.test(f)).sort();
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const docOf = (text) => yaml.loadAll(text)[0];
const sig = (f) => [f.check, f.severity, f.job === undefined ? "-" : f.job].join(":");
const sigs = (list) => list.map(sig);

// Fixtures where rules.js is expected to differ from the reference engine (the three documented deviations).
const DEVIATING = new Set(["setup-go.yml", "setup-node.yml", "cache-false.yml"]);

// What each fixture must produce from rules.js (check:severity:job).
const EXPECTED = {
  "clean.yml": [],
  "all-defects.yml": [
    "no-concurrency-cancel:defect:-", "no-job-timeout:defect:test", "full-history-checkout:observation:test",
    "setup-without-cache:defect:test", "unpinned-third-party-action:defect:test"],
  "on-string.yml": ["no-concurrency-cancel:defect:-"],
  "on-list.yml": ["no-concurrency-cancel:defect:-"],
  "on-quoted.yml": ["no-concurrency-cancel:defect:-"],
  "on-true-key.yml": ["no-concurrency-cancel:defect:-"],
  "on-schedule-only.yml": [],
  "reusable.yml": ["no-job-timeout:defect:plain"],
  "local-docker.yml": [],
  "docker-digest.yml": ["unpinned-third-party-action:defect:build"],
  "sha-pins.yml": [
    "unpinned-third-party-action:defect:build", "unpinned-third-party-action:defect:build",
    "unpinned-third-party-action:defect:build", "unpinned-third-party-action:defect:build",
    "unpinned-third-party-action:defect:build"],
  "flow-style.yml": [
    "no-concurrency-cancel:defect:-", "no-job-timeout:defect:build", "full-history-checkout:observation:build",
    "setup-without-cache:defect:build", "unpinned-third-party-action:defect:build"],
  "comments-quotes.yml": [
    "no-concurrency-cancel:defect:-", "no-job-timeout:defect:quoted-job", "setup-without-cache:defect:quoted-job",
    "unpinned-third-party-action:defect:quoted-job"],
  "setup-go.yml": ["setup-without-cache:defect:v3", "setup-without-cache:defect:sha", "setup-without-cache:defect:bare"],
  "setup-node.yml": [
    "setup-without-cache:defect:v4", "setup-without-cache:observation:v5", "setup-without-cache:observation:v6-minor",
    "setup-without-cache:observation:v5-empty-cache", "setup-without-cache:defect:sha"],
  "cache-false.yml": ["setup-without-cache:defect:build", "setup-without-cache:defect:build"],
  "checkout-depth.yml": [
    "full-history-checkout:observation:build", "full-history-checkout:observation:build",
    "full-history-checkout:observation:build"],
  "multi-job.yml": [
    "no-concurrency-cancel:defect:-", "no-job-timeout:defect:lint", "setup-without-cache:defect:lint",
    "unpinned-third-party-action:defect:test", "no-job-timeout:defect:deploy", "unpinned-third-party-action:defect:deploy"],
  "not-a-workflow.yml": [],
  "odd-types.yml": [
    "no-concurrency-cancel:defect:-", "no-job-timeout:defect:steps-not-list", "setup-without-cache:defect:mixed-steps"]
};

test("every fixture has an expectation", () => {
  assert.deepEqual(fixtureNames.slice().sort(), Object.keys(EXPECTED).sort());
});

for (const name of fixtureNames) {
  test("fixture " + name + ": findings", () => {
    const found = rules.checkWorkflow(name, docOf(read(name)));
    assert.deepEqual(sigs(found), EXPECTED[name]);
    for (const f of found) {
      assert.equal(f.file, name);
      assert.ok(f.detail && typeof f.detail === "string");
      assert.ok(rules.CHECK_CLASS[f.check], "class for " + f.check);
    }
  });

  test("fixture " + name + ": CRLF text gives the same findings and lines", () => {
    const lf = read(name);
    const crlf = lf.replace(/\n/g, "\r\n");
    const a = rules.checkWorkflow(name, docOf(lf));
    const b = rules.checkWorkflow(name, docOf(crlf));
    assert.deepEqual(b, a);
    for (let i = 0; i < a.length; i++) {
      assert.equal(rules.locate(crlf, b[i]), rules.locate(lf, a[i]), name + " finding " + i);
    }
  });

  test("fixture " + name + ": parity with the reference engine", () => {
    const doc = docOf(read(name));
    const mine = rules.checkWorkflow(name, doc);
    const ref = reference.checkWorkflow(name, doc);
    if (!DEVIATING.has(name)) {
      assert.deepEqual(mine, ref);
    } else {
      assert.notDeepEqual(mine, ref, name + " is meant to exercise a documented deviation");
    }
  });
}

test("on: [push], on: push, quoted on, and the true-key fallback give the documented triggers", () => {
  const trig = (n) => rules.checkWorkflow(n, docOf(read(n)))[0].triggers;
  assert.deepEqual(trig("on-string.yml"), ["push"]);
  assert.deepEqual(trig("on-list.yml"), ["push"]);
  assert.deepEqual(trig("on-quoted.yml"), ["pull_request"]);
  assert.deepEqual(trig("on-true-key.yml"), ["push"]);
  assert.deepEqual(trig("flow-style.yml"), ["pull_request", "push"]);
  // an object built the way PyYAML would build it: boolean true key, which JS stringifies to "true"
  const doc = {true: {push: null}, jobs: {}};
  assert.deepEqual(rules.checkWorkflow("x", doc), reference.checkWorkflow("x", doc));
  assert.equal(rules.checkWorkflow("x", doc)[0].check, "no-concurrency-cancel");
});

test("concurrency present (any truthy value) silences the concurrency check", () => {
  const doc = {on: "push", concurrency: "ci", jobs: {}};
  assert.deepEqual(rules.checkWorkflow("x", doc), []);
  const doc2 = {on: "push", concurrency: {group: "g"}, jobs: {}};
  assert.deepEqual(rules.checkWorkflow("x", doc2), []);
});

test("job-level uses skips the timeout rule but timeout-minutes: 0 still counts as set", () => {
  const found = rules.checkWorkflow("x", {jobs: {a: {uses: "o/r/.github/workflows/w.yml@v1"}, b: {"timeout-minutes": 0}}});
  assert.deepEqual(found, []);
});

test("SHA pin check: 40 hex in either case passes, anything else is a moving reference", () => {
  const refs = rules.checkWorkflow("sha-pins.yml", docOf(read("sha-pins.yml"))).map((f) => f.ref);
  assert.deepEqual(refs, [
    "0123456789abcdef0123456789abcdef0123456",
    "0123456789abcdef0123456789abcdef012345678",
    "0123456789abcdef0123456789abcdef0123456g",
    "main", "v1"]);
});

test("CHECK_CLASS equals the engine's", () => {
  assert.deepEqual(rules.CHECK_CLASS, reference.CHECK_CLASS);
  assert.deepEqual(Object.keys(rules.CHECK_CLASS).sort(),
    ["full-history-checkout", "no-concurrency-cancel", "no-job-timeout", "setup-without-cache", "unpinned-third-party-action"]);
});

/* ---- the three documented deviations, asserted explicitly, with the engine's behaviour alongside ---- */

test("deviation (a): explicit cache: false is not flagged (the engine flags it)", () => {
  const doc = docOf(read("cache-false.yml"));
  const mine = rules.checkWorkflow("f", doc);
  const ref = reference.checkWorkflow("f", doc);
  assert.equal(ref.length, 6);
  assert.deepEqual(mine.map((f) => f.action), ["actions/setup-java", "ruby/setup-ruby"]);
  assert.deepEqual(mine.map((f) => f.cache_key), ["cache", "bundler-cache"]);
  // each finding that survives is byte-identical to the engine's finding for the same step
  for (const f of mine) assert.ok(ref.some((r) => JSON.stringify(r) === JSON.stringify(f)));
  for (const key of ["cache", "bundler-cache"]) {
    for (const action of Object.keys(rules.CACHEABLE_SETUP).filter((a) => rules.CACHEABLE_SETUP[a] === key)) {
      const d = {jobs: {j: {"timeout-minutes": 1, steps: [{uses: action + "@v3", with: {[key]: false}}]}}};
      const cacheOnly = (list) => list.filter((f) => f.check === "setup-without-cache");
      assert.deepEqual(cacheOnly(rules.checkWorkflow("f", d)), [], action);
      assert.equal(cacheOnly(reference.checkWorkflow("f", d)).length, 1, action);
    }
  }
});

test("deviation (b): setup-go at v4 or later is not flagged, earlier or unversioned refs still are", () => {
  const mine = rules.checkWorkflow("f", docOf(read("setup-go.yml")));
  const ref = reference.checkWorkflow("f", docOf(read("setup-go.yml")));
  assert.deepEqual(ref.map((f) => f.job), ["v3", "v4", "v5", "v5-cache-false", "sha", "bare"]);
  assert.deepEqual(mine.map((f) => f.job), ["v3", "sha", "bare"]);
  const one = (r) => rules.checkWorkflow("f", {jobs: {j: {"timeout-minutes": 1, steps: [{uses: "actions/setup-go@" + r}]}}}).length;
  assert.equal(one("v3"), 1);
  assert.equal(one("v3.5.0"), 1);
  assert.equal(one("v4"), 0);
  assert.equal(one("v4.0.1"), 0);
  assert.equal(one("v10"), 0);
  assert.equal(one("5"), 0);
  assert.equal(one("main"), 1);
  assert.equal(one("0123456789abcdef0123456789abcdef01234567"), 1);
  // a 40-digit all-numeric ref is a SHA, not major version 1234...
  assert.equal(one("1234567890123456789012345678901234567890"), 1);
});

test("deviation (c): setup-node at v5 or later becomes an observation that mentions packageManager", () => {
  const doc = docOf(read("setup-node.yml"));
  const mine = rules.checkWorkflow("f", doc);
  const ref = reference.checkWorkflow("f", doc);
  assert.equal(ref.length, 7);
  assert.ok(ref.every((f) => f.severity === "defect"));
  const byJob = Object.fromEntries(mine.map((f) => [f.job, f]));
  assert.deepEqual(Object.keys(byJob).sort(), ["sha", "v4", "v5", "v5-empty-cache", "v6-minor"]);
  assert.equal(byJob.v4.severity, "defect");
  assert.equal(byJob.sha.severity, "defect");
  for (const j of ["v5", "v6-minor", "v5-empty-cache"]) {
    const f = byJob[j];
    assert.equal(f.severity, "observation");
    assert.equal(f.check, "setup-without-cache");
    assert.equal(f.action, "actions/setup-node");
    assert.equal(f.cache_key, "cache");
    assert.match(f.detail, /v5 and later cache npm automatically only when package\.json declares packageManager/);
  }
  // v4 keeps the engine's exact finding
  assert.deepEqual(byJob.v4, ref.find((f) => f.job === "v4"));
});

test("refs that are not version tags are judged as the engine judges them", () => {
  for (const r of ["main", "master", "latest", "0123456789abcdef0123456789abcdef01234567", "release/v5"]) {
    const d = {jobs: {j: {"timeout-minutes": 1, steps: [{uses: "actions/setup-node@" + r}]}}};
    assert.deepEqual(rules.checkWorkflow("f", d), reference.checkWorkflow("f", d), r);
  }
});

/* ---- parity fuzz: random workflows that avoid the deviation triggers must match the engine exactly ---- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("parity fuzz: 1500 generated workflows (outside the deviations) match the engine exactly", () => {
  const rnd = mulberry32(20261002);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const USES = ["actions/checkout@v4", "actions/checkout@v3", "actions/setup-node@v4", "actions/setup-node@v3",
    "actions/setup-node@main", "actions/setup-python@v5", "actions/setup-java@v4", "actions/setup-dotnet@v4",
    "ruby/setup-ruby@v1", "actions/setup-go@v3", "actions/setup-go@main", "actions/setup-go@" + sha, "org/act@v1",
    "org/act@" + sha, "org/act@" + sha.toUpperCase(), "org/act@" + sha.slice(1), "org/act", "org/sub/path@main",
    "./local", "./.github/actions/x", "docker://alpine:3", "actions/cache@v4", "  actions/checkout@v4  ", 123, null, "", true];
  const CACHE_VALUES = ["npm", "pip", "", null, 0, true, "false", "no", 1];     // never boolean false (deviation a)
  const WITHS = () => {
    const r = rnd();
    if (r < 0.2) return undefined;
    if (r < 0.3) return null;
    if (r < 0.35) return "text";
    if (r < 0.4) return ["a"];
    const w = {};
    if (rnd() < 0.5) w.cache = pick(CACHE_VALUES);
    if (rnd() < 0.5) w["bundler-cache"] = pick(CACHE_VALUES);
    if (rnd() < 0.5) w["fetch-depth"] = pick([0, "0", 1, "1", null, "abc", "", 0.0, "00"]);
    if (rnd() < 0.3) w["node-version"] = 20;
    return w;
  };
  const STEP = () => {
    const r = rnd();
    if (r < 0.08) return pick(["str", 5, null, ["x"]]);
    const s = {};
    if (rnd() < 0.9) s.uses = pick(USES);
    const w = WITHS();
    if (w !== undefined) s["with"] = w;
    if (rnd() < 0.3) s.run = "echo";
    return s;
  };
  const JOB = () => {
    const r = rnd();
    if (r < 0.06) return pick([null, "x", 7, ["a"]]);
    const j = {};
    if (rnd() < 0.55) j["timeout-minutes"] = pick([5, 0, null, "10"]);
    if (rnd() < 0.12) j.uses = "o/r/.github/workflows/w.yml@v1";
    const k = rnd();
    if (k < 0.85) { j.steps = []; const n = Math.floor(rnd() * 6); for (let i = 0; i < n; i++) j.steps.push(STEP()); }
    else if (k < 0.92) j.steps = "nope";
    return j;
  };
  const TRIGGERS = () => pick([
    "push", "pull_request", "schedule", "workflow_dispatch", ["push"], ["pull_request", "push"], ["schedule"], [],
    {push: null}, {pull_request: {branches: ["main"]}}, {push: {}, pull_request: {}}, {schedule: [{cron: "0 0 * * *"}]},
    null, 5, true]);
  let withFindings = 0;
  for (let n = 0; n < 1500; n++) {
    const doc = {};
    const t = TRIGGERS();
    const r = rnd();
    if (r < 0.7) doc.on = t; else if (r < 0.9) doc["true"] = t;             // else: no trigger key at all
    if (rnd() < 0.4) doc.concurrency = pick(["g", {group: "g"}, true, "", null, 0]);
    const jr = rnd();
    if (jr < 0.9) { doc.jobs = {}; const m = Math.floor(rnd() * 4); for (let i = 0; i < m; i++) doc.jobs["job" + i] = JOB(); }
    else if (jr < 0.95) doc.jobs = ["a"];
    else doc.jobs = null;
    const mine = rules.checkWorkflow("f.yml", doc);
    const ref = reference.checkWorkflow("f.yml", doc);
    assert.deepEqual(mine, ref, "case " + n + ": " + JSON.stringify(doc));
    if (mine.length) withFindings++;
  }
  assert.ok(withFindings > 600, "the generator should hit the rules often (" + withFindings + ")");
  for (const bad of [null, undefined, 5, "str", ["a"], true]) {
    assert.deepEqual(rules.checkWorkflow("f", bad), reference.checkWorkflow("f", bad));
  }
});

/* ---- fixFor ---- */

test("fixFor gives a short YAML snippet for every check", () => {
  const all = rules.checkWorkflow("all.yml", docOf(read("all-defects.yml")));
  const checks = {};
  for (const f of all) {
    const fix = rules.fixFor(f);
    assert.ok(fix.length > 10 && fix.length < 400, f.check + " fix length " + fix.length);
    checks[f.check] = fix;
  }
  assert.match(checks["no-concurrency-cancel"], /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true/);
  assert.match(checks["no-job-timeout"], /^jobs:\n {2}test:\n {4}timeout-minutes: 15/);
  assert.match(checks["setup-without-cache"], /actions\/setup-python step\nwith:\n {2}cache: pip/);
  assert.match(checks["full-history-checkout"], /fetch-depth: 1/);
  assert.match(checks["unpinned-third-party-action"], /^uses: some-org\/lint-action@<full 40-character commit SHA> {3}# v2\n# find the SHA: gh api repos\/some-org\/lint-action\/commits\/v2 --jq \.sha$/);
});

test("fixFor cache keys per setup action", () => {
  const want = {
    "actions/setup-node": "cache: npm", "actions/setup-python": "cache: pip", "actions/setup-java": "cache: maven",
    "actions/setup-go": "cache: true", "actions/setup-dotnet": "cache: true", "ruby/setup-ruby": "bundler-cache: true"
  };
  for (const [action, line] of Object.entries(want)) {
    const fix = rules.fixFor({check: "setup-without-cache", action, cache_key: rules.CACHEABLE_SETUP[action]});
    assert.ok(fix.includes("\n  " + line), action + ": " + fix);
  }
  assert.equal(rules.fixFor({check: "setup-without-cache", action: "x/unknown", cache_key: "cache"}).split("\n")[2], "  cache: true");
});

test("fixFor never lets workflow-controlled text break out of a code fence", () => {
  const evil = "x```\n```yaml\n::set-env";
  const fixes = [
    rules.fixFor({check: "no-job-timeout", job: evil}),
    rules.fixFor({check: "unpinned-third-party-action", action: evil + "/b", ref: evil}),
    rules.fixFor({check: "setup-without-cache", action: evil, cache_key: evil})
  ];
  for (const fix of fixes) {
    assert.ok(!fix.includes("`"), fix);
    assert.ok(!/\n```/.test(fix));
  }
  assert.ok(!fixes[0].includes("\n```"));
  assert.equal(rules.fixFor({check: "nope"}), "");
  assert.equal(rules.fixFor(null), "");
  assert.equal(rules.fixFor(undefined), "");
});

test("DEVIATIONS documents the three differences", () => {
  assert.equal(rules.DEVIATIONS.length, 3);
  assert.match(rules.DEVIATIONS[0], /cache: false/);
  assert.match(rules.DEVIATIONS[1], /setup-go/);
  assert.match(rules.DEVIATIONS[2], /setup-node/);
});
