"use strict";
/* CI Speed Check rules: the same five deterministic checks as Weio's free browser check and paid CI audit
 * (parity-tested against test/reference/ci_check.js), with three deliberate, documented deviations (see
 * DEVIATIONS). Pure functions only: no file, network or process access, so a VS Code extension can reuse it.
 *
 *   checkWorkflow(name, doc)  -> finding objects (same shape as the engine)
 *   fixFor(finding)           -> short YAML fix snippet
 *   locate(text, finding)     -> 1-based line number in the workflow text
 */

var CACHEABLE_SETUP = {
  "actions/setup-node": "cache", "actions/setup-python": "cache", "actions/setup-java": "cache",
  "actions/setup-go": "cache", "actions/setup-dotnet": "cache", "ruby/setup-ruby": "bundler-cache"
};

var CHECK_CLASS = {
  "setup-without-cache": "slowness", "no-concurrency-cancel": "slowness",
  "no-job-timeout": "hygiene", "unpinned-third-party-action": "security",
  "full-history-checkout": "slowness"
};

// Where this implementation deliberately differs from the engine in test/reference/ci_check.js.
var DEVIATIONS = [
  "A setup step whose cache input is explicitly false (cache: false, bundler-cache: false) is not flagged: " +
    "that is a decision, not an oversight.",
  "actions/setup-go at major ref v4 or later is not flagged: it caches by default from v4.",
  "actions/setup-node at major ref v5 or later is reported as an observation, not a defect: v5 caches npm " +
    "automatically only when package.json declares packageManager."
];

function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function repr(s) { return "'" + String(s) + "'"; }  // mirrors Python %r for plain strings

// Major version of a version-tag ref ("v4", "v5.1.0", "5"), or null for SHAs, branches and anything else.
function refMajor(ref) {
  ref = String(ref);
  if (ref.length === 40 && /^[0-9a-f]+$/.test(ref.toLowerCase())) return null;
  var m = /^v?(\d+)(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.+-]*)?$/i.exec(ref);
  return m ? parseInt(m[1], 10) : null;
}

function explicitlyFalse(v) {
  return v === false || (typeof v === "string" && v.trim().toLowerCase() === "false");
}

function checkWorkflow(name, doc) {
  var found = [];
  if (!isObj(doc)) return found;
  var jobs = isObj(doc.jobs) ? doc.jobs : {};
  // YAML 1.1 (PyYAML) reads a bare `on:` key as boolean true; js-yaml keeps "on".
  var on = ("on" in doc) ? doc.on : doc["true"];
  var triggers = [];
  if (isObj(on)) triggers = Object.keys(on);
  else if (Array.isArray(on)) triggers = on.slice();
  else if (typeof on === "string") triggers = [on];
  var hit = ["pull_request", "push"].filter(function (t) { return triggers.indexOf(t) >= 0; });
  if (hit.length && !doc.concurrency) {
    found.push({check: "no-concurrency-cancel", severity: "defect", file: name, triggers: hit,
      detail: "runs on " + hit.join("/") + " with no top-level concurrency group, so superseded " +
              "commits keep running and paying"});
  }
  Object.keys(jobs).forEach(function (jobName) {
    var job = jobs[jobName];
    if (!isObj(job)) return;
    if (!("timeout-minutes" in job) && !("uses" in job)) {
      found.push({check: "no-job-timeout", severity: "defect", file: name, job: jobName,
        detail: "job " + repr(jobName) + " has no timeout-minutes; a hang costs the 360-minute default"});
    }
    var steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach(function (step) {
      if (!isObj(step)) return;
      var uses = String(step.uses || "").trim();
      if (!uses) return;
      var action = uses.split("@")[0];
      var w = isObj(step["with"]) ? step["with"] : {};
      var key = CACHEABLE_SETUP[action];
      if (key && !w[key] && !explicitlyFalse(w[key])) {
        var major = uses.indexOf("@") >= 0 ? refMajor(uses.slice(uses.indexOf("@") + 1)) : null;
        if (action === "actions/setup-go" && major !== null && major >= 4) {
          // deviation (b): caches by default from v4, nothing to report
        } else if (action === "actions/setup-node" && major !== null && major >= 5) {
          found.push({check: "setup-without-cache", severity: "observation", file: name, job: jobName,
            action: action, cache_key: key,
            detail: "job " + repr(jobName) + " uses " + action + " without `" + key + ":`; v5 and later cache npm " +
                    "automatically only when package.json declares packageManager, so dependencies may still " +
                    "be re-downloaded every run"});
        } else {
          found.push({check: "setup-without-cache", severity: "defect", file: name, job: jobName,
            action: action, cache_key: key,
            detail: "job " + repr(jobName) + " uses " + action + " without `" + key + ":`; dependencies are " +
                    "re-downloaded every run"});
        }
      }
      if (action === "actions/checkout" && String(w["fetch-depth"] === undefined ? "" : w["fetch-depth"]) === "0") {
        found.push({check: "full-history-checkout", severity: "observation", file: name, job: jobName,
          detail: "job " + repr(jobName) + " clones full history (fetch-depth: 0); slow, and " +
                  "required if anything here reads git history"});
      }
      if (action.indexOf("/") >= 0 && action.indexOf("actions/") !== 0 && uses.indexOf("@") >= 0) {
        var ref = uses.slice(uses.indexOf("@") + 1);
        if (!(ref.length === 40 && /^[0-9a-f]+$/.test(ref.toLowerCase()))) {
          found.push({check: "unpinned-third-party-action", severity: "defect", file: name, job: jobName,
            action: action, ref: ref,
            detail: "job " + repr(jobName) + " pins " + action + " to " + repr(ref) + ", a moving reference"});
        }
      }
    });
  });
  return found;
}

/* ---------------------------------------------------------------- fixes */

var CACHE_FIX = {
  "actions/setup-node": "cache: npm   # or yarn, pnpm",
  "actions/setup-python": "cache: pip   # or pipenv, poetry",
  "actions/setup-java": "cache: maven   # or gradle, sbt",
  "actions/setup-go": "cache: true",
  "actions/setup-dotnet": "cache: true",
  "ruby/setup-ruby": "bundler-cache: true"
};

// Values that come from the workflow file are interpolated into snippets that end up in markdown code fences
// and annotations: drop newlines and backticks so they cannot break out.
function clean(s) { return String(s).replace(/[\r\n`]+/g, " ").trim().slice(0, 160); }

function fixFor(f) {
  if (!f || typeof f !== "object") return "";
  switch (f.check) {
    case "no-concurrency-cancel":
      return "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n" +
             "  cancel-in-progress: true   # use false for deploy workflows";
    case "no-job-timeout":
      return "jobs:\n  " + clean(f.job) + ":\n    timeout-minutes: 15   # about 2-3x the job's normal run time";
    case "setup-without-cache": {
      var line = CACHE_FIX[f.action] || (clean(f.cache_key || "cache") + ": true");
      return "# on the " + clean(f.action) + " step\nwith:\n  " + line;
    }
    case "full-history-checkout":
      return "# on the actions/checkout step\nwith:\n  fetch-depth: 1   # the default; keep 0 only if something reads git history";
    case "unpinned-third-party-action": {
      var action = clean(f.action), ref = clean(f.ref);
      var parts = action.split("/");
      var out = "uses: " + action + "@<full 40-character commit SHA>   # " + ref;
      if (parts.length >= 2 && /^[A-Za-z0-9_.-]+$/.test(parts[0]) && /^[A-Za-z0-9_.-]+$/.test(parts[1]) &&
          /^[A-Za-z0-9_.\/-]+$/.test(ref)) {
        out += "\n# find the SHA: gh api repos/" + parts[0] + "/" + parts[1] + "/commits/" + ref + " --jq .sha";
      }
      return out;
    }
    default:
      return "";
  }
}

/* --------------------------------------------------------------- locate */

// Remove a trailing YAML comment, honouring quotes. A quote only opens at the start of a token, so an
// apostrophe inside a plain scalar ("don't") does not hide a later comment.
function stripComment(s) {
  var q = null;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) {
        if (q === "'" && s.charAt(i + 1) === "'") i++;
        else q = null;
      }
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s\[{,]/.test(s.charAt(i - 1))) q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s.charAt(i - 1)))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function unquoteDouble(s) {
  return s.replace(/\\(["\\\/]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|.)/g, function (_, e) {
    if (e === "n") return "\n";
    if (e === "t") return "\t";
    if (e.length > 1 && (e.charAt(0) === "x" || e.charAt(0) === "u")) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e;
  });
}

// A mapping-key line: {indent, key} or null. Handles plain, "double" and 'single' quoted keys.
function parseKey(code) {
  var indent = /^ */.exec(code)[0].length;
  var s = code.slice(indent).replace(/\s+$/, "");
  var m;
  if (s.charAt(0) === '"') {
    m = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s|$)/.exec(s);
    return m ? {indent: indent, key: unquoteDouble(m[1])} : null;
  }
  if (s.charAt(0) === "'") {
    m = /^'((?:[^']|'')*)'\s*:(?:\s|$)/.exec(s);
    return m ? {indent: indent, key: m[1].replace(/''/g, "'")} : null;
  }
  m = /^([^\s#{}\[\],&*!|>%@`'"?-][^#]*?|-[^\s#][^#]*?)\s*:(?:\s|$)/.exec(s);
  return m ? {indent: indent, key: m[1]} : null;
}

// Split text into lines and mark which ones carry structure. Only the first YAML document is scanned.
// Lines inside block scalars (run: |), blank lines and comment lines are marked skip.
function prepare(text) {
  var src = String(text === undefined || text === null ? "" : text).replace(/^\uFEFF/, "");
  var raw = src.split(/\r\n|\r|\n/);
  var lines = [], started = false, topIndent = 0, block = null;
  for (var i = 0; i < raw.length; i++) {
    var line = raw[i];
    var trimmed = line.trim();
    var indent = /^ */.exec(line)[0].length;
    var entry = {n: i + 1, indent: indent, code: "", skip: true};
    lines.push(entry);
    if (block !== null) {
      if (trimmed === "" || indent > block) continue;
      block = null;
    }
    if (trimmed === "" || trimmed.charAt(0) === "#") continue;
    if (indent === 0 && /^---(\s|$)/.test(line)) { if (started) { lines.pop(); break; } continue; }
    if (indent === 0 && /^\.\.\.(\s|$)/.test(line)) { if (started) { lines.pop(); break; } continue; }
    if (!started && indent === 0 && line.charAt(0) === "%") continue;
    var code = stripComment(line).replace(/\s+$/, "");
    if (!started) { started = true; topIndent = indent; }
    entry.code = code;
    entry.skip = false;
    // Block scalar header: "key: |", "key: >-", "- |"
    // Content lines are those indented deeper than the key's column (the length of "  - " style prefixes
    // counts, so for "  - run: |" the key column is 4).
    if (/:\s+(?:[&!]\S*\s+)*[|>][+\-0-9]{0,2}$/.test(code)) {
      block = /^( *(?:-\s+)*)/.exec(code)[1].length;
    } else if (/^ *-\s+(?:[&!]\S*\s+)*[|>][+\-0-9]{0,2}$/.test(code)) {
      block = indent;
    }
  }
  return {lines: lines, topIndent: topIndent};
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

var USES_RE = /(?:^|[\s{,])(?:"uses"|'uses'|uses)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s,{}\[\]]+))/;

function usesValue(code) {
  var m = USES_RE.exec(code);
  if (!m) return null;
  var v = m[1] !== undefined ? unquoteDouble(m[1]) : (m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]);
  return String(v).trim();
}

// Index range [start, end) of the step that contains the uses line at index i, within [lo, hi).
function stepRange(lines, i, lo, hi) {
  var cur = lines[i];
  var start = i, dashIndent;
  if (/^ *-\s/.test(cur.code)) {
    dashIndent = cur.indent;
  } else {
    var keyIndent = cur.indent;
    dashIndent = keyIndent - 1;
    for (var j = i - 1; j >= lo; j--) {
      var l = lines[j];
      if (l.skip) continue;
      if (l.indent < keyIndent) {
        if (/^ *-\s/.test(l.code)) { start = j; dashIndent = l.indent; }
        break;
      }
    }
  }
  var end = hi;
  for (var k = start + 1; k < hi; k++) {
    var m = lines[k];
    if (m.skip) continue;
    if (m.indent <= dashIndent) { end = k; break; }
  }
  return [start, end];
}

// occurrence (optional, 0-based): which of several identical findings in one file this is, so that two
// `actions/checkout` steps in a job that both clone full history point at their own lines.
function locate(text, finding, occurrence) {
  try {
    return locateInner(text, finding, occurrence > 0 ? occurrence : 0) || 1;
  } catch (e) {
    return 1;
  }
}

function locateInner(text, finding, occ) {
  if (!finding || typeof finding !== "object") return 1;
  var P = prepare(text), lines = P.lines, top = P.topIndent, i;

  if (finding.check === "no-concurrency-cancel") {
    for (i = 0; i < lines.length; i++) {
      if (lines[i].skip || lines[i].indent !== top) continue;
      var k = parseKey(lines[i].code);
      if (k && (k.key === "on" || k.key === "true")) return lines[i].n;
    }
    // flow-style top level: {on: push, jobs: {...}}
    for (i = 0; i < lines.length; i++) {
      if (!lines[i].skip && /(?:^|[\s{,])(?:"on"|'on'|on)\s*:/.test(lines[i].code)) return lines[i].n;
    }
    return 1;
  }

  if (finding.job === undefined || finding.job === null) return 1;
  var jobName = String(finding.job);

  // top-level jobs: key
  var jl = -1;
  for (i = 0; i < lines.length; i++) {
    if (lines[i].skip || lines[i].indent !== top) continue;
    var jk = parseKey(lines[i].code);
    if (jk && jk.key === "jobs") { jl = i; break; }
  }
  if (jl < 0) return 1;

  // jobs block: lines after jl more indented than the top level, up to the next top-level line
  var jobsEnd = lines.length, jobIndent = -1;
  for (i = jl + 1; i < lines.length; i++) {
    if (lines[i].skip) continue;
    if (lines[i].indent <= top) { jobsEnd = i; break; }
    if (jobIndent < 0) jobIndent = lines[i].indent;
  }
  var entries = [];
  if (jobIndent >= 0) {
    for (i = jl + 1; i < jobsEnd; i++) {
      if (lines[i].skip || lines[i].indent !== jobIndent) continue;
      var ek = parseKey(lines[i].code);
      if (ek) entries.push({key: ek.key, idx: i});
    }
  }
  var start = -1, end = jobsEnd;
  for (i = 0; i < entries.length; i++) {
    if (entries[i].key === jobName) {
      start = entries[i].idx;
      end = i + 1 < entries.length ? entries[i + 1].idx : jobsEnd;
      break;
    }
  }
  if (start < 0) {
    // flow-style jobs: {name: {...}}, or the job key sharing the jobs: line
    var re = new RegExp("(?:^|[\\s{,])(?:\"" + escapeRe(jobName) + "\"|'" + escapeRe(jobName) + "'|" +
                        escapeRe(jobName) + ")\\s*:");
    for (i = jl; i < jobsEnd; i++) {
      if (!lines[i].skip && re.test(lines[i].code)) return lines[i].n;
    }
    return 1;
  }
  if (!finding.action && finding.check !== "full-history-checkout") return lines[start].n;

  // step findings: the uses line inside the job's range
  var wantAction = finding.action || "actions/checkout";
  var wantFull = finding.check === "unpinned-third-party-action" ? wantAction + "@" + finding.ref : null;
  var cands = [];
  for (i = start; i < end; i++) {
    if (lines[i].skip) continue;
    var v = usesValue(lines[i].code);
    if (v === null) continue;
    if (wantFull !== null ? v === wantFull : v.split("@")[0] === wantAction) cands.push(i);
  }
  if (!cands.length) return lines[start].n;
  var pool = cands;
  if (cands.length > 1) {
    var chosen = [];
    if (finding.check === "full-history-checkout") {
      var pred = /(?:^|[\s{,])(?:"fetch-depth"|'fetch-depth'|fetch-depth)\s*:\s*["']?0+["']?(?=\s|,|}|$)/;
      chosen = cands.filter(function (c) {
        var r = stepRange(lines, c, start, end);
        return lines.slice(r[0], r[1]).some(function (l) { return !l.skip && pred.test(l.code); });
      });
    } else if (finding.check === "setup-without-cache" && finding.cache_key) {
      var cre = new RegExp("(?:^|[\\s{,])(?:\"" + escapeRe(finding.cache_key) + "\"|'" + escapeRe(finding.cache_key) +
                           "'|" + escapeRe(finding.cache_key) + ")\\s*:\\s*(?!''|\"\"|null\\b|~)[^\\s,}]");
      chosen = cands.filter(function (c) {
        var r = stepRange(lines, c, start, end);
        return !lines.slice(r[0], r[1]).some(function (l) { return !l.skip && cre.test(l.code); });
      });
    }
    if (chosen.length) pool = chosen;
  }
  return lines[pool[occ < pool.length ? occ : 0]].n;
}

module.exports = {
  checkWorkflow: checkWorkflow,
  CHECK_CLASS: CHECK_CLASS,
  CACHEABLE_SETUP: CACHEABLE_SETUP,
  DEVIATIONS: DEVIATIONS,
  fixFor: fixFor,
  locate: locate
};
