"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const yaml = require("../src/vendor/js-yaml.min.js");
const rules = require("../src/rules");

const join = (lines, eol) => lines.join(eol || "\n") + (eol || "\n");
const findings = (text) => rules.checkWorkflow("w.yml", yaml.loadAll(text)[0]);
const find = (text, check, pred) => findings(text).filter((f) => f.check === check && (!pred || pred(f)));
const lineOf = (text, check, pred) => {
  const hits = find(text, check, pred);
  assert.ok(hits.length, "no " + check + " finding");
  return rules.locate(text, hits[0]);
};

const BASIC = [
  "# header comment",            // 1
  "name: CI",                    // 2
  "on:",                         // 3
  "  push:",                     // 4
  "jobs:",                       // 5
  "  build:",                    // 6
  "    runs-on: ubuntu-latest",  // 7
  "    steps:",                  // 8
  "      - uses: actions/checkout@v4",       // 9
  "        with:",                           // 10
  "          fetch-depth: 0",                // 11
  "      - uses: actions/setup-node@v4",     // 12
  "      - uses: foo/bar@v1",                // 13
  "  test:",                     // 14
  "    runs-on: ubuntu-latest",  // 15
  "    steps:",                  // 16
  "      - uses: actions/setup-python@v5"    // 17
];

test("concurrency finding points at the top-level on: key", () => {
  assert.equal(lineOf(join(BASIC), "no-concurrency-cancel"), 3);
});

test("job findings point at the job key line", () => {
  const text = join(BASIC);
  assert.equal(lineOf(text, "no-job-timeout", (f) => f.job === "build"), 6);
  assert.equal(lineOf(text, "no-job-timeout", (f) => f.job === "test"), 14);
});

test("step findings point at the uses line inside the right job", () => {
  const text = join(BASIC);
  assert.equal(lineOf(text, "full-history-checkout"), 9);
  assert.equal(lineOf(text, "setup-without-cache", (f) => f.job === "build"), 12);
  assert.equal(lineOf(text, "unpinned-third-party-action"), 13);
  assert.equal(lineOf(text, "setup-without-cache", (f) => f.job === "test"), 17);
});

test("quoted on keys, a true: key and flow-style top levels", () => {
  assert.equal(lineOf(join(["name: x", '"on":', "  push:", "jobs: {}"]), "no-concurrency-cancel"), 2);
  assert.equal(lineOf(join(["name: x", "'on': [push]", "jobs: {}"]), "no-concurrency-cancel"), 2);
  assert.equal(lineOf(join(["name: x", "", "on: push # comment", "jobs: {}"]), "no-concurrency-cancel"), 3);
  assert.equal(lineOf(join(["name: x", "true:", "  push:", "jobs: {}"]), "no-concurrency-cancel"), 2);
  assert.equal(lineOf(join(["{on: push, jobs: {}}"]), "no-concurrency-cancel"), 1);
  assert.equal(lineOf(join(["", "", "{name: x, on: [push], jobs: {}}"]), "no-concurrency-cancel"), 3);
});

test("quoted job keys and keys with spaces", () => {
  const text = join([
    "on: workflow_dispatch",              // 1
    "jobs:",                              // 2
    '  "quoted-job":',                    // 3
    "    runs-on: ubuntu-latest",         // 4
    "  'other job':",                     // 5
    "    runs-on: ubuntu-latest",         // 6
    "  plain_job: # comment",             // 7
    "    runs-on: ubuntu-latest"          // 8
  ]);
  assert.equal(lineOf(text, "no-job-timeout", (f) => f.job === "quoted-job"), 3);
  assert.equal(lineOf(text, "no-job-timeout", (f) => f.job === "other job"), 5);
  assert.equal(lineOf(text, "no-job-timeout", (f) => f.job === "plain_job"), 7);
});

test("CRLF, lone CR and a BOM do not shift line numbers", () => {
  const lf = join(BASIC);
  const checks = (text) => findings(text).map((f) => rules.locate(text, f));
  const expected = checks(lf);
  assert.deepEqual(expected, [3, 6, 9, 12, 13, 14, 17]);
  assert.deepEqual(checks(join(BASIC, "\r\n")), expected);
  assert.deepEqual(checks(join(BASIC, "\r")), expected);
  assert.deepEqual(checks("\uFEFF" + lf), expected);
});

test("comments and block scalars cannot be mistaken for structure", () => {
  const text = join([
    "# on: push",                                   // 1
    "# jobs:",                                      // 2
    "on: push",                                     // 3
    "jobs:",                                        // 4
    "  # build:",                                   // 5
    "  build:",                                     // 6
    "    steps:",                                   // 7
    "      # - uses: foo/bar@v1",                   // 8
    "      - run: |",                               // 9
    "          echo uses: foo/bar@v1",              // 10
    "          jobs:",                              // 11
    "      - name: x # uses: foo/bar@v1",           // 12
    "        uses: foo/bar@v1 # the real one",      // 13
    "      - run: >-",                              // 14
    "          uses: foo/bar@v1",                   // 15
    "      - uses: foo/bar@v1"                      // 16
  ]);
  const hits = find(text, "unpinned-third-party-action");
  assert.equal(hits.length, 2);
  assert.equal(rules.locate(text, hits[0]), 13);
  assert.equal(rules.locate(text, hits[1]), 13);   // identical findings: the first matching step wins
  assert.equal(lineOf(text, "no-concurrency-cancel"), 3);
  assert.equal(lineOf(text, "no-job-timeout"), 6);
});

test("with two similar steps the line chosen is the one the finding is about", () => {
  const text = join([
    "on: workflow_dispatch",                   // 1
    "jobs:",                                   // 2
    "  a:",                                    // 3
    "    timeout-minutes: 1",                  // 4
    "    steps:",                              // 5
    "      - uses: actions/checkout@v4",       // 6
    "        with:",                           // 7
    "          fetch-depth: 1",                // 8
    "      - name: deep",                      // 9
    "        uses: actions/checkout@v4",       // 10
    "        with:",                           // 11
    "          fetch-depth: 0",                // 12
    "      - uses: actions/setup-node@v4",     // 13
    "        with:",                           // 14
    "          cache: npm",                    // 15
    "      - uses: actions/setup-node@v4",     // 16
    "        with:",                           // 17
    "          node-version: 20"               // 18
  ]);
  assert.equal(lineOf(text, "full-history-checkout"), 10);
  assert.equal(lineOf(text, "setup-without-cache"), 16);
});

test("a with: block listed before uses: still belongs to its step", () => {
  const text = join([
    "on: workflow_dispatch",                   // 1
    "jobs:",                                   // 2
    "  a:",                                    // 3
    "    timeout-minutes: 1",                  // 4
    "    steps:",                              // 5
    "      - with:",                           // 6
    "          cache: npm",                    // 7
    "        uses: actions/setup-node@v4",     // 8
    "      - with:",                           // 9
    "          node-version: 20",              // 10
    "        uses: actions/setup-node@v4"      // 11
  ]);
  assert.equal(lineOf(text, "setup-without-cache"), 11);
});

test("flow-style steps and jobs", () => {
  const steps = join([
    "on: workflow_dispatch",                                                                // 1
    "jobs:",                                                                                // 2
    "  a:",                                                                                 // 3
    "    timeout-minutes: 1",                                                               // 4
    "    steps:",                                                                           // 5
    "      - {uses: actions/checkout@v4, with: {fetch-depth: 1}}",                          // 6
    "      - {uses: 'actions/checkout@v4', with: {fetch-depth: 0}}",                        // 7
    "      - {name: x, uses: \"foo/bar@v2\"}"                                               // 8
  ]);
  assert.equal(lineOf(steps, "full-history-checkout"), 7);
  assert.equal(lineOf(steps, "unpinned-third-party-action"), 8);
  const inline = "jobs: {build: {runs-on: ubuntu-latest, steps: [{uses: foo/bar@v1}]}}\n";
  assert.equal(lineOf(inline, "no-job-timeout"), 1);
  assert.equal(lineOf(inline, "unpinned-third-party-action"), 1);
});

test("only the first YAML document is searched", () => {
  const text = join([
    "---",                              // 1
    "on: push",                         // 2
    "jobs:",                            // 3
    "  one:",                           // 4
    "    runs-on: x",                   // 5
    "---",                              // 6
    "on: push",                         // 7
    "jobs:",                            // 8
    "  two:",                           // 9
    "    runs-on: x"                    // 10
  ]);
  const first = yaml.loadAll(text)[0];
  const f = rules.checkWorkflow("w", first);
  assert.deepEqual(f.map((x) => rules.locate(text, x)), [2, 4]);
  assert.equal(rules.locate(text, {check: "no-job-timeout", job: "two"}), 1);
});

test("a uniformly indented document and a directive line", () => {
  const text = join(["%YAML 1.2", "---", "  on: push", "  jobs:", "    a:", "      runs-on: x"]);
  const f = rules.checkWorkflow("w", yaml.loadAll(text)[0]);
  assert.deepEqual(f.map((x) => rules.locate(text, x)), [3, 5]);
});

test("fallback is line 1", () => {
  const text = join(BASIC);
  assert.equal(rules.locate(text, {check: "no-job-timeout", job: "missing"}), 1);
  assert.equal(rules.locate(text, {check: "no-job-timeout"}), 1);
  assert.equal(rules.locate(text, {check: "something-else", job: "build"}), 6);
  assert.equal(rules.locate(text, {check: "unpinned-third-party-action", job: "build", action: "x/y", ref: "v1"}), 6);
  assert.equal(rules.locate("", {check: "no-concurrency-cancel"}), 1);
  assert.equal(rules.locate("jobs:\n  a:\n    steps: []\n", {check: "no-concurrency-cancel"}), 1);
  assert.equal(rules.locate("not: yaml: at all: [", {check: "no-job-timeout", job: "a"}), 1);
  assert.equal(rules.locate(undefined, {check: "no-job-timeout", job: "a"}), 1);
  assert.equal(rules.locate(null, null), 1);
  assert.equal(rules.locate(text), 1);
  assert.equal(rules.locate(text, "nonsense"), 1);
});

test("job names containing regular expression characters are matched literally", () => {
  const text = join([
    "on: workflow_dispatch",           // 1
    "jobs:",                           // 2
    "  build:",                        // 3
    "    runs-on: x",                  // 4
    '  "a.b(c)+":',                    // 5
    "    runs-on: x"                   // 6
  ]);
  assert.equal(lineOf(text, "no-job-timeout", (f) => f.job === "a.b(c)+"), 5);
  assert.equal(rules.locate(text, {check: "no-job-timeout", job: "a.b(c)+x"}), 1);
});

test("quoted-flow job fallback finds a job whose key shares the jobs line", () => {
  const text = join(["on: push", "jobs: {'my job': {steps: []}}"]);
  assert.equal(rules.locate(text, {check: "no-job-timeout", job: "my job"}), 2);
});

test("identical findings are told apart with the occurrence argument", () => {
  const text = join([
    "on: workflow_dispatch",                   // 1
    "jobs:",                                   // 2
    "  a:",                                    // 3
    "    timeout-minutes: 1",                  // 4
    "    steps:",                              // 5
    "      - uses: actions/checkout@v4",       // 6
    "        with:",                           // 7
    "          fetch-depth: 0",                // 8
    "      - uses: actions/checkout@v4",       // 9
    "        with:",                           // 10
    "          fetch-depth: 1",                // 11
    "      - uses: actions/checkout@v4",       // 12
    "        with:",                           // 13
    "          fetch-depth: '0'",              // 14
    "      - uses: actions/setup-node@v4",     // 15
    "      - uses: actions/setup-node@v4",     // 16
    "        with: {cache: npm}",              // 17
    "      - uses: actions/setup-node@v4",     // 18
    "        with: {cache: ''}",               // 19
    "      - uses: foo/bar@v1",                // 20
    "      - uses: foo/bar@v1"                 // 21
  ]);
  const all = findings(text);
  const by = (check) => all.filter((f) => f.check === check);
  const lines = (check) => by(check).map((f, i) => rules.locate(text, f, i));
  assert.deepEqual(lines("full-history-checkout"), [6, 12]);
  assert.deepEqual(lines("setup-without-cache"), [15, 18]);
  assert.deepEqual(lines("unpinned-third-party-action"), [20, 21]);
  // without the argument every identical finding points at the first match
  assert.deepEqual(by("full-history-checkout").map((f) => rules.locate(text, f)), [6, 6]);
  // an occurrence beyond the matches falls back to the first
  assert.equal(rules.locate(text, by("full-history-checkout")[0], 9), 6);
  assert.equal(rules.locate(text, by("full-history-checkout")[0], -1), 6);
});
