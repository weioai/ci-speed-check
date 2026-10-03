"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const yaml = require("../src/vendor/js-yaml.min.js");
const rules = require("../src/rules");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const action = yaml.load(read("action.yml"));
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");

test("action.yml: metadata, branding, runtime", () => {
  assert.equal(action.name, "CI Speed Check");
  assert.ok(action.description.length > 20 && action.description.length <= 120, "description length " + action.description.length);
  assert.equal(action.author, "Weio, Inc.");
  assert.deepEqual(action.branding, {icon: "zap", color: "green"});
  assert.deepEqual(action.runs, {using: "node20", main: "src/index.js"});
  assert.ok(fs.existsSync(path.join(ROOT, action.runs.main)));
});

test("action.yml: inputs and outputs as specified", () => {
  const i = action.inputs;
  assert.deepEqual(Object.keys(i), ["path", "fail-on", "annotate", "api-key", "github-token", "repository", "history-runs", "history-days"]);
  assert.equal(i.path.default, ".github/workflows");
  assert.equal(i["fail-on"].default, "none");
  assert.equal(i.annotate.default, "true");
  assert.equal(i["github-token"].default, "${{ github.token }}");
  assert.equal(i.repository.default, "${{ github.repository }}");
  assert.equal(i["history-runs"].default, "100");
  assert.equal(i["history-days"].default, "30");
  assert.ok(!i["api-key"].required);
  assert.deepEqual(Object.keys(action.outputs), ["findings", "defects", "pro", "report"]);
});

test("action.yml: no composite steps and no shell", () => {
  assert.ok(!/^\s*steps:/m.test(read("action.yml")));
  assert.ok(!/\brun:/.test(read("action.yml")));
  assert.notEqual(action.runs.using, "composite");
});

test("README documents every input and output in action.yml", () => {
  for (const name of Object.keys(action.inputs).concat(Object.keys(action.outputs))) {
    assert.ok(readme.includes("| `" + name + "` |"), name);
  }
});

test("package.json", () => {
  assert.equal(pkg.name, "ci-speed-check");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.test, "node --test test/");
  assert.equal(pkg.engines.node, ">=18");
  assert.ok(!pkg.dependencies && !pkg.devDependencies && !pkg.optionalDependencies && !pkg.peerDependencies);
});

test("LICENSE files", () => {
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 Weio, Inc\./);
  assert.match(read("src/vendor/LICENSE-js-yaml"), /Copyright \(C\) 2011-2015 by Vitaly Puzrin/);
  assert.match(read("src/vendor/LICENSE-js-yaml"), /The MIT License/);
});

test("vendored js-yaml keeps its license header and matches the supplied copy", () => {
  const vendored = fs.readFileSync(path.join(ROOT, "src/vendor/js-yaml.min.js"));
  assert.ok(vendored.toString("utf8", 0, 80).startsWith("/*! js-yaml 4.1.0 https://github.com/nodeca/js-yaml @license MIT */"));
  const supplied = path.join(ROOT, "..", "src", "js-yaml.min.js");
  if (fs.existsSync(supplied)) assert.ok(vendored.equals(fs.readFileSync(supplied)), "byte copy of the supplied js-yaml");
  assert.equal(typeof yaml.loadAll, "function");
});

test("the reference engine is a byte copy of the supplied ci_check.js", () => {
  const ref = fs.readFileSync(path.join(ROOT, "test/reference/ci_check.js"));
  assert.ok(ref.toString("utf8").includes("check_workflow"));
  const supplied = path.join(ROOT, "..", "src", "ci_check.js");
  if (fs.existsSync(supplied)) assert.ok(ref.equals(fs.readFileSync(supplied)));
});

test("zero runtime dependencies: src requires only node built-ins and local files", () => {
  const builtins = new Set(require("module").builtinModules);
  const files = ["src/index.js", "src/rules.js", "src/history.js"];
  for (const f of files) {
    for (const m of read(f).matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const name = m[1];
      assert.ok(name.startsWith(".") || builtins.has(name), f + " requires " + name);
    }
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "node_modules")));
});

test("history.js has no GitHub-Actions-specific I/O", () => {
  const src = read("src/history.js");
  assert.ok(!/require\(/.test(src), "history.js requires nothing");
  assert.ok(!/process\.(env|stdout|stderr)|\bGITHUB_(?!ERROR)|console\./.test(src));
});

test("BUY_URL is a single constant", () => {
  const url = "https://weio.ai/services/site-check-api.html";
  let n = 0;
  for (const f of ["src/index.js", "src/rules.js", "src/history.js"]) n += read(f).split(url).length - 1;
  assert.equal(n, 1);
  assert.match(read("src/index.js"), /var BUY_URL = "https:\/\/weio\.ai\/services\/site-check-api\.html";/);
});

test("README quick start passes our own slowness and hygiene checks; only the action's own tag is reported", () => {
  const block = /## Quick start[\s\S]*?```yaml\n([\s\S]*?)```/.exec(readme)[1];
  const doc = yaml.load(block);
  assert.deepEqual(doc.on, {pull_request: null});
  assert.deepEqual(doc.permissions, {contents: "read"});
  assert.ok(doc.concurrency);
  const steps = doc.jobs["ci-speed-check"].steps;
  assert.equal(steps[0].uses, "actions/checkout@v4");
  assert.equal(steps[1].uses, "weioai/ci-speed-check@v1");
  assert.equal(doc.jobs["ci-speed-check"]["timeout-minutes"], 5);
  const found = rules.checkWorkflow("quickstart.yml", doc);
  assert.deepEqual(found.map((f) => [f.check, f.action, f.ref]), [["unpinned-third-party-action", "weioai/ci-speed-check", "v1"]]);
  assert.match(readme, /moving tag, so the security check reports it too/);
});

test("README Pro example passes the slowness and hygiene checks and grants actions: read", () => {
  const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const pro = blocks.find((b) => b.includes("api-key: ${{ secrets.WEIO_API_KEY }}"));
  const doc = yaml.load(pro);
  assert.equal(doc.permissions.actions, "read");
  assert.equal(doc.permissions.contents, "read");
  const found = rules.checkWorkflow("pro.yml", doc).map((f) => f.check);
  assert.deepEqual(found, ["unpinned-third-party-action"]);
});

test("README states the Pro facts exactly and makes no savings claims", () => {
  assert.ok(readme.includes("costs $9 for 1,000 credits"));
  assert.ok(readme.includes("emailed automatically within minutes of Stripe payment"));
  assert.ok(readme.includes("valid for 12 months"));
  assert.ok(readme.includes("The same key also works for Weio's site-check API."));
  assert.ok(readme.includes("One Pro run = one credit."));
  assert.ok(readme.includes("https://weio.ai/services/site-check-api.html"));
  assert.ok(readme.includes("sales@weio.ai"));
  assert.ok(readme.includes("a small California company where AI operators do most of the work and a human owner is accountable"));
  // the only dollar amount on the page is the key price
  assert.deepEqual(readme.match(/\$\d[\d,.]*/g), ["$9"]);
  assert.ok(!/!\[|shields\.io|badge|testimonial|stars?\b|% faster|save[sd]? \d/i.test(readme));
  assert.ok(!/—/.test(readme), "no em dashes");
});

test("README privacy section matches what the code does", () => {
  assert.match(readme, /Free mode\*\*: .* makes no network requests/);
  assert.match(readme, /No telemetry/);
  const src = read("src/index.js") + read("src/history.js");
  // the only outbound calls are the GitHub API reads and the credit POST
  const fetches = src.match(/\bfetchImpl\(|\bf\(url|\bfetch\(/g) || [];
  assert.ok(fetches.length >= 2 && fetches.length <= 4, String(fetches.length));
});

test("examples/selftest.yml runs the action on its own fixtures and lives outside .github", () => {
  const doc = yaml.load(read("examples/selftest.yml"));
  const steps = doc.jobs.selftest.steps;
  const self = steps.find((s) => s.uses === "./");
  assert.equal(self.with.path, "test/fixtures");
  assert.deepEqual(rules.checkWorkflow("selftest.yml", doc), []);
  assert.ok(!fs.existsSync(path.join(ROOT, ".github")));
  // outputs reach the shell through env, not by interpolation into the script
  const showStep = steps.find((s) => s.run);
  assert.ok(!/\$\{\{/.test(showStep.run));
});

test("every fixture is valid YAML so the self-test never trips a parse warning", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "test/fixtures"))) {
    assert.doesNotThrow(() => yaml.loadAll(read("test/fixtures/" + f)), f);
  }
});
