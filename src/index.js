"use strict";
/* CI Speed Check: GitHub Action entry point.
 *
 * Free mode reads the workflow files under `path`, applies five deterministic rules and reports them as
 * annotations, a job summary and a JSON report. Nothing leaves the runner.
 *
 * Pro mode (api-key set) additionally reads the repository's Actions run history from GitHub with the
 * workflow's own token and uses one Weio credit. Pro problems never fail the job.
 *
 * Zero runtime dependencies; the little bit of @actions/core we need is implemented here.
 */

var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var yaml = require("./vendor/js-yaml.min.js");
var rules = require("./rules");
var history = require("./history");

var BUY_URL = "https://weio.ai/services/site-check-api.html";
var DEFAULT_WEIO_BASE = "https://weio.ai";
var DEFAULT_GITHUB_API = "https://api.github.com";
var KEY_RE = /^wk_[A-Za-z0-9_-]{24,64}$/;
var CREDIT_TIMEOUT_MS = 15000;
var MAX_FILES = 500;
var MAX_FILE_BYTES = 1024 * 1024;
var MAX_ANNOTATIONS = 10;          // GitHub shows at most 10 warnings and 10 notices per step
var MAX_TABLE_ROWS = 200;
var SUMMARY_LIMIT = 900 * 1024;    // GitHub caps a step summary at 1 MiB

var VERSION = (function () {
  try { return require("../package.json").version || "1.0.0"; } catch (e) { return "1.0.0"; }
})();

/* ------------------------------------------- minimal @actions/core bits */

function escapeData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}
function formatCommand(cmd, props, message) {
  var line = "::" + cmd;
  var parts = [];
  Object.keys(props || {}).forEach(function (k) {
    var v = props[k];
    if (v !== undefined && v !== null && v !== "") parts.push(k + "=" + escapeProperty(v));
  });
  if (parts.length) line += " " + parts.join(",");
  return line + "::" + escapeData(message === undefined ? "" : message);
}
function out(line) { process.stdout.write(line + "\n"); }
function command(cmd, props, message) { out(formatCommand(cmd, props, message)); }
// Plain log lines: never let GitHub-derived text start a workflow command.
function info(msg) { out("ci-speed-check: " + String(msg).replace(/[\r\n]+/g, " ")); }
function warning(message, props) { command("warning", props || {title: "CI Speed Check"}, message); }
function notice(message, props) { command("notice", props || {title: "CI Speed Check"}, message); }
function errorAnnotation(message) { command("error", {title: "CI Speed Check"}, message); }
function addMask(secret) { out(formatCommand("add-mask", {}, secret)); }

function getInput(name, env) {
  env = env || process.env;
  var v = env["INPUT_" + String(name).replace(/ /g, "_").toUpperCase()];
  return v === undefined || v === null ? "" : String(v).trim();
}

function setOutput(name, value, env) {
  env = env || process.env;
  var file = env.GITHUB_OUTPUT;
  if (!file) return;
  var delim = "ghadelimiter_" + crypto.randomUUID();
  fs.appendFileSync(file, name + "<<" + delim + "\n" + String(value) + "\n" + delim + "\n");
}

/* ------------------------------------------------------------- helpers */

function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
function codeSpan(s) { return "`" + String(s).replace(/[`\r\n]+/g, " ") + "`"; }
function cleanText(s, max) {
  return String(s === undefined || s === null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max || 200);
}
function isLoopback(host) { return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"; }
function parseBase(raw, requireHttps) {
  var u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (!requireHttps || isLoopback(u.hostname)))) return null;
  return String(raw).replace(/\/+$/, "");
}
function intInput(raw, dflt, lo, hi) {
  var n = parseInt(raw, 10);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function collectFiles(root) {
  var found = [];
  (function walk(dir, depth) {
    if (depth > 8 || found.length >= MAX_FILES) return;
    var ents;
    try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch (e) { return; }
    ents.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    ents.forEach(function (ent) {
      if (found.length >= MAX_FILES || ent.isSymbolicLink()) return;
      var p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules" && ent.name !== ".git") walk(p, depth + 1);
      } else if (ent.isFile() && /\.ya?ml$/i.test(ent.name)) {
        found.push(p);
      }
    });
  })(root, 0);
  return found;
}

/* ----------------------------------------------------------- summaries */

function renderSummary(m) {
  var E = history.mdEscape, L = [];
  L.push("## CI Speed Check", "");
  if (m.problem) {
    L.push(E(m.problem), "");
  } else if (!m.files.length) {
    L.push("No workflow files (*.yml, *.yaml) were found under " + codeSpan(m.path) +
           ". If this job has not run actions/checkout yet, add it before this step.", "");
  } else {
    var d = m.findings.filter(function (f) { return f.severity === "defect"; }).length;
    var o = m.findings.length - d;
    if (!m.findings.length) {
      L.push("None of the five rules found anything in the " + plural(m.files.length, "workflow file") + " under " +
             codeSpan(m.path) + ". That does not mean your CI is fast: see what this check cannot see, below.", "");
    } else {
      L.push("Read " + plural(m.files.length, "workflow file") + " under " + codeSpan(m.path) + ": **" +
             plural(d, "defect") + "** and **" + plural(o, "observation") + "**.", "");
      var rows = m.findings.slice(0, MAX_TABLE_ROWS).map(function (f) {
        return "| " + [E(f.file + ":" + f.line), f.job !== undefined ? E(f.job) : "(workflow)",
          E(f.check + (f.severity === "observation" ? " (observation)" : "")), E(f.class), E(f.detail)].join(" | ") + " |";
      });
      L.push("| File | Job | Check | Class | Detail |", "| --- | --- | --- | --- | --- |");
      rows.forEach(function (r) { L.push(r); });
      if (m.findings.length > MAX_TABLE_ROWS) {
        L.push("", (m.findings.length - MAX_TABLE_ROWS) + " more findings are in the JSON report.");
      }
      L.push("");
      // one example fix per kind of finding (per action for caches), listing where it applies
      var groups = [], byKey = Object.create(null);
      m.findings.forEach(function (f) {
        if (!f.fix) return;
        var k = f.check + (f.check === "setup-without-cache" ? "\u0000" + f.action : "");
        if (!byKey[k]) { byKey[k] = {check: f.check, fix: f.fix, where: [], example: f}; groups.push(byKey[k]); }
        byKey[k].where.push(f.file + ":" + f.line);
      });
      if (groups.length) {
        L.push("### Fixes", "");
        groups.forEach(function (x) {
          var shown = x.where.slice(0, 5).map(E).join(", ");
          if (x.where.length > 5) shown += " and " + (x.where.length - 5) + " more";
          var ex = x.example;
          var eg = x.where.length > 1 && (ex.job !== undefined || ex.action) ? " Example, from " + E(ex.file + ":" + ex.line) + ":" : "";
          L.push("**" + E(x.check) + "** (" + plural(x.where.length, "place") + ": " + shown + ")." + eg, "", "```yaml", x.fix, "```", "");
        });
      }
    }
    if (m.parseErrors.length) {
      L.push("### Files that could not be read", "");
      m.parseErrors.forEach(function (p) { L.push("- " + E(p.file) + ": " + E(p.message)); });
      L.push("");
    }
  }
  if (m.deviationsUsed && m.deviationsUsed.length) {
    L.push("### Where this differs from the web check and paid audit", "");
    m.deviationsUsed.forEach(function (x) { L.push("- " + E(x)); });
    L.push("");
  }
  L.push("### What this check cannot see", "");
  L.push("- How long your builds and tests actually take. It reads configuration, not runs; the Pro run-history report measures real runs.");
  L.push("- Runner size, flaky tests, cache hit rates or whether a cache key is any good.");
  L.push("- What is inside reusable workflows and composite actions: only the workflow files under the path above are read.");
  L.push("- Whether a job-level reusable workflow reference (`uses:` on a job) is pinned; only step-level actions are checked.");
  L.push("- Whether your triggers fit how your team works. A missing concurrency group is a defect for CI, not for a deploy that must finish.");
  L.push("");
  if (m.pro) {
    if (m.pro.markdown) {
      L.push(m.pro.markdown);
    } else {
      L.push("### Pro: run history", "", "Weio Pro was skipped: " + E(m.pro.skipped), "");
    }
    if (m.pro.creditLine) L.push(E(m.pro.creditLine), "");
  } else {
    L.push("Pro: add `api-key` to also read your repository's run history and get measured minutes (superseded runs, slowest jobs, queue time). A Weio API key is $9 for 1,000 credits, and one Pro run uses one credit: " + BUY_URL, "");
  }
  var md = L.join("\n");
  if (md.length > SUMMARY_LIMIT) md = md.slice(0, SUMMARY_LIMIT) + "\n\n(summary truncated)\n";
  return md;
}

/* ----------------------------------------------------------------- Pro */

function ProSkip(message, creditUsed) {
  var e = new Error(message);
  e.name = "ProSkip";
  e.proSkip = true;
  e.creditUsed = !!creditUsed;
  return e;
}

async function creditPost(fetchImpl, base, apiKey, slug) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, CREDIT_TIMEOUT_MS);
  try {
    var res = await fetchImpl(base + "/api/credit?for=ci-speed-check&ref=" + slug, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "User-Agent": "weio-ci-speed-check/" + VERSION,
        "Accept": "application/json"
      },
      signal: ctl.signal
    });
    var body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return {status: res.status, body: body};
  } finally {
    clearTimeout(timer);
  }
}

/* Returns {markdown, report, creditUsed, creditsRemaining} or {skipped, creditUsed}. Never throws. */
async function runPro(ctx) {
  var apiKey = ctx.apiKey, env = ctx.env;
  function redact(s) { return String(s).split(apiKey).join("***"); }
  function skip(msg, creditUsed) {
    return {skipped: redact(msg), creditUsed: !!creditUsed, creditsRemaining: null};
  }
  var buy = " Get or top up a key: " + BUY_URL;
  if (!KEY_RE.test(apiKey)) {
    return skip("the api-key value does not look like a Weio API key (expected wk_ followed by 24 to 64 letters, digits, _ or -)." + buy);
  }
  var slug = ctx.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    return skip("the repository input is not in owner/repo form.");
  }
  var fetchImpl = ctx.fetchImpl;
  if (typeof fetchImpl !== "function") return skip("this Node.js has no fetch (Node 18 or later is required).");
  var weioBase = parseBase(env.WEIO_API_BASE || DEFAULT_WEIO_BASE, true);
  if (!weioBase) return skip("WEIO_API_BASE must be an https URL.");
  var ghBase = parseBase(env.GITHUB_API_URL || DEFAULT_GITHUB_API, false);
  if (!ghBase) return skip("GITHUB_API_URL is not a valid URL.");

  var parts = slug.split("/");
  var creditUsed = false, creditsRemaining = null;
  try {
    var report = await history.analyze({
      owner: parts[0], repo: parts[1], token: ctx.token, maxRuns: ctx.maxRuns, days: ctx.days,
      fetchImpl: fetchImpl, apiBase: ghBase,
      onFirstPage: async function () {
        var r;
        try {
          r = await creditPost(fetchImpl, weioBase, apiKey, slug);
        } catch (e) {
          throw ProSkip("could not reach Weio to use a credit (" + (e && e.name === "AbortError" ? "no answer within 15 s" : "network error") + ")." + buy, false);
        }
        var b = r.body && typeof r.body === "object" ? r.body : {};
        if (r.status === 200 && b.ok !== false) {
          creditUsed = true;
          if (typeof b.credits_remaining === "number" && isFinite(b.credits_remaining)) creditsRemaining = b.credits_remaining;
          return;
        }
        var text = cleanText(typeof b.error === "string" && b.error ? b.error : "HTTP " + r.status, 200);
        var tail = r.status === 429 || r.status >= 500 ? " Try again later." : "";
        throw ProSkip("Weio said: " + text + " (HTTP " + r.status + ")." + tail + buy, false);
      }
    });
    var md = history.renderMarkdown(report);
    var creditLine = creditUsed
      ? "One Weio credit was used for this run" + (creditsRemaining !== null ? "; " + creditsRemaining + " credits remain on this key." : ".")
      : "The run window held no runs, so no credit was used.";
    return {markdown: md, report: report, creditUsed: creditUsed, creditsRemaining: creditsRemaining, creditLine: creditLine};
  } catch (e) {
    if (e && e.proSkip) return skip(e.message, e.creditUsed);
    if (e && e.name === "HistoryError") {
      return skip(e.message + (creditUsed ? "" : " No credit was used."), creditUsed);
    }
    return skip("unexpected error while reading the run history (" + cleanText(e && e.message, 120) + ")." +
                (creditUsed ? " A credit had already been used." : " No credit was used."), creditUsed);
  }
}

/* ---------------------------------------------------------------- main */

async function main(env) {
  env = env || process.env;

  // Mask the key before anything else can print.
  var apiKey = getInput("api-key", env);
  if (apiKey) addMask(apiKey);

  var failOn = getInput("fail-on", env).toLowerCase() || "none";
  if (["none", "defect", "any"].indexOf(failOn) < 0) {
    warning("fail-on must be none, defect or any; got " + cleanText(failOn, 40) + ". Using none.");
    failOn = "none";
  }
  var annotateOn = (getInput("annotate", env) || "true").toLowerCase() !== "false";
  var inputPath = getInput("path", env) || ".github/workflows";
  var workspace = path.resolve(env.GITHUB_WORKSPACE || process.cwd());
  var root = path.resolve(workspace, inputPath);
  var rel0 = path.relative(workspace, root);
  var insideWorkspace = rel0 === "" || (!rel0.startsWith("..") && !path.isAbsolute(rel0));

  var model = {path: inputPath, files: [], findings: [], parseErrors: [], problem: null, pro: null, deviationsUsed: []};
  var files = [];
  if (!insideWorkspace) {
    model.problem = "path must be inside the workspace, so nothing was read.";
    warning("path must be inside the workspace (" + cleanText(inputPath, 120) + "); nothing was checked.");
  } else {
    try {
      var st = fs.lstatSync(root);
      if (st.isSymbolicLink()) {
        warning("path is a symbolic link, which is not followed: " + cleanText(inputPath, 120));
      } else if (st.isFile()) {
        files = [root];
      } else if (st.isDirectory()) {
        files = collectFiles(root);
      }
    } catch (e) {
      warning("path not found: " + cleanText(inputPath, 120) + ". Run actions/checkout first, or set path.");
    }
  }
  if (files.length >= MAX_FILES) warning("Only the first " + MAX_FILES + " workflow files were read.");

  files.forEach(function (abs) {
    var rel = path.relative(workspace, abs).split(path.sep).join("/");
    var props = {file: rel, title: "CI Speed Check"};
    try {
      if (fs.statSync(abs).size > MAX_FILE_BYTES) {
        warning("skipped: file is larger than 1 MiB", props);
        model.parseErrors.push({file: rel, message: "larger than 1 MiB, skipped"});
        return;
      }
      var text = fs.readFileSync(abs, "utf8");
      var docs;
      try {
        docs = yaml.loadAll(text);
      } catch (e) {
        var reason = cleanText(e && e.reason ? e.reason : (e && e.message ? String(e.message).split("\n")[0] : "invalid YAML"), 160);
        var where = e && e.mark && typeof e.mark.line === "number" ? " (line " + (e.mark.line + 1) + ")" : "";
        warning("could not parse this file as YAML: " + reason + where + ". It was not checked.", props);
        model.parseErrors.push({file: rel, message: reason + where});
        return;
      }
      model.files.push(rel);
      var found = rules.checkWorkflow(rel, docs[0]);
      var seen = Object.create(null);
      found.forEach(function (f) {
        // identical findings (two full-history checkouts in one job) each get their own step's line
        var sig = [f.check, f.job, f.action, f.ref, f.cache_key].join("\u0000");
        var nth = seen[sig] || 0;
        seen[sig] = nth + 1;
        f.line = rules.locate(text, f, nth);
        f.class = rules.CHECK_CLASS[f.check];
        f.fix = rules.fixFor(f);
        model.findings.push(f);
      });
    } catch (e) {
      warning("could not check this file: " + cleanText(e && e.message, 160), props);
      model.parseErrors.push({file: rel, message: cleanText(e && e.message, 160)});
    }
  });

  var defects = model.findings.filter(function (f) { return f.severity === "defect"; }).length;
  var observations = model.findings.length - defects;

  // deviations that actually shaped this result are worth stating next to it
  if (model.findings.some(function (f) { return f.check === "setup-without-cache" && f.severity === "observation"; })) {
    model.deviationsUsed.push(rules.DEVIATIONS[2]);
  }

  info("read " + plural(model.files.length, "workflow file") + ", " + plural(defects, "defect") + ", " + plural(observations, "observation"));

  // annotations
  if (annotateOn) {
    var warned = 0, noticed = 0, hidden = 0;
    model.findings.forEach(function (f) {
      var isDefect = f.severity === "defect";
      if ((isDefect && warned >= MAX_ANNOTATIONS) || (!isDefect && noticed >= MAX_ANNOTATIONS)) { hidden++; return; }
      var msg = f.detail + (f.fix ? "\n\nFix:\n" + f.fix : "");
      var props = {file: f.file, line: f.line, title: "CI Speed Check: " + f.check};
      if (isDefect) { warned++; warning(msg, props); } else { noticed++; notice(msg, props); }
    });
    if (hidden) info(hidden + " more findings are listed in the job summary and the JSON report");
  }

  // Pro
  var requested = !!apiKey;
  if (requested) {
    var repository = getInput("repository", env) || env.GITHUB_REPOSITORY || "";
    var pro = await runPro({
      apiKey: apiKey, env: env, repository: repository, token: getInput("github-token", env),
      maxRuns: intInput(getInput("history-runs", env), 100, 1, history.MAX_RUNS),
      days: intInput(getInput("history-days", env), 30, 1, 365),
      fetchImpl: typeof fetch === "function" ? fetch : null
    });
    model.pro = pro;
    if (pro.skipped) {
      warning("Weio Pro was skipped: " + pro.skipped, {title: "CI Speed Check Pro"});
    } else {
      info("Weio Pro run history read" + (pro.creditUsed ? ", one credit used" +
           (pro.creditsRemaining !== null ? ", " + pro.creditsRemaining + " remaining" : "") : ", no credit used"));
    }
  }

  // JSON report (never holds the key)
  var reportPath = "";
  try {
    var dir = env.RUNNER_TEMP || os.tmpdir();
    reportPath = path.join(dir, "ci-speed-check-report-" + crypto.randomBytes(4).toString("hex") + ".json");
    var body = {
      tool: "ci-speed-check",
      version: VERSION,
      generatedAt: new Date().toISOString(),
      path: inputPath,
      failOn: failOn,
      files: model.files,
      parseErrors: model.parseErrors,
      counts: {findings: model.findings.length, defects: defects, observations: observations},
      findings: model.findings,
      deviations: rules.DEVIATIONS,
      pro: {
        requested: requested,
        ran: !!(model.pro && model.pro.report),
        creditUsed: !!(model.pro && model.pro.creditUsed),
        creditsRemaining: model.pro && typeof model.pro.creditsRemaining === "number" ? model.pro.creditsRemaining : null,
        skipped: model.pro && model.pro.skipped ? model.pro.skipped : null,
        history: model.pro && model.pro.report ? model.pro.report : null
      }
    };
    fs.writeFileSync(reportPath, JSON.stringify(body, null, 2) + "\n", {flag: "wx", mode: 0o600});
  } catch (e) {
    warning("could not write the JSON report: " + cleanText(e && e.message, 120));
    reportPath = "";
  }

  // job summary
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(model) + "\n");
    } catch (e) {
      warning("could not write the job summary: " + cleanText(e && e.message, 120));
    }
  }

  // outputs
  try {
    setOutput("findings", model.findings.length, env);
    setOutput("defects", defects, env);
    setOutput("pro", model.pro && model.pro.report ? "true" : "false", env);
    setOutput("report", reportPath, env);
  } catch (e) {
    warning("could not write step outputs: " + cleanText(e && e.message, 120));
  }

  if ((failOn === "defect" && defects > 0) || (failOn === "any" && model.findings.length > 0)) {
    var count = failOn === "defect" ? defects : model.findings.length;
    errorAnnotation("fail-on is " + failOn + " and " + plural(count, failOn === "defect" ? "defect" : "finding") +
                    (count === 1 ? " was" : " were") + " found.");
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then(function (code) {
    process.exitCode = code;
  }, function (e) {
    // An unexpected bug. With fail-on none the action must not break the build; with a gate on, fail loudly.
    var gate = ["defect", "any"].indexOf(getInput("fail-on").toLowerCase()) >= 0;
    var msg = "internal error: " + cleanText(e && e.message, 200);
    if (gate) { errorAnnotation(msg); process.exitCode = 1; } else { warning(msg); process.exitCode = 0; }
  });
}

module.exports = {
  main: main, escapeData: escapeData, escapeProperty: escapeProperty, formatCommand: formatCommand,
  getInput: getInput, setOutput: setOutput, renderSummary: renderSummary, BUY_URL: BUY_URL, KEY_RE: KEY_RE, VERSION: VERSION
};
