/* Weio free CI check: the same deterministic rules as the paid audit's check_workflow
 * (company-os/revenue/ci_audit_probe.py), run in the visitor's browser. Nothing is uploaded.
 * Parity with the Python engine is enforced by test_ci_check_parity.py. */
(function (root) {
  "use strict";
  var CACHEABLE_SETUP = {
    "actions/setup-node": "cache", "actions/setup-python": "cache", "actions/setup-java": "cache",
    "actions/setup-go": "cache", "actions/setup-dotnet": "cache", "ruby/setup-ruby": "bundler-cache"
  };
  var CHECK_CLASS = {
    "setup-without-cache": "slowness", "no-concurrency-cancel": "slowness",
    "no-job-timeout": "hygiene", "unpinned-third-party-action": "security",
    "full-history-checkout": "slowness"
  };
  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function repr(s) { return "'" + String(s) + "'"; }  // mirrors Python %r for plain strings

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
        if (key && !w[key]) {
          found.push({check: "setup-without-cache", severity: "defect", file: name, job: jobName,
            action: action, cache_key: key,
            detail: "job " + repr(jobName) + " uses " + action + " without `" + key + ":`; dependencies are " +
                    "re-downloaded every run"});
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
  var api = {checkWorkflow: checkWorkflow, CHECK_CLASS: CHECK_CLASS};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WeioCICheck = api;
})(this);
