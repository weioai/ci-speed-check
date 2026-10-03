"use strict";
// Separate file so the 15 s wait runs in parallel with the rest of the suite.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const {spawn} = require("child_process");
const M = require("./mocks");

const KEY = "wk_TESTKEY0123456789abcdefghijkl";
const BUY_URL = "https://weio.ai/services/site-check-api.html";

test("Pro: a credit request that gets no answer is abandoned after 15 s with a warning, exit 0, no job data read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csc-timeout-"));
  fs.mkdirSync(path.join(dir, ".github/workflows"), {recursive: true});
  fs.writeFileSync(path.join(dir, ".github/workflows/ci.yml"), "on: push\njobs:\n  a:\n    runs-on: x\n    steps: []\n");
  const log = [];
  const gh = await M.startServer(M.makeHandler(M.scenario(), {log}));
  const hang = http.createServer(() => { log.push("credit"); /* never answer */ });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  try {
    const env = {
      PATH: process.env.PATH, NODE_NO_WARNINGS: "1", GITHUB_WORKSPACE: dir, GITHUB_REPOSITORY: "acme/widgets",
      "INPUT_API-KEY": KEY, "INPUT_GITHUB-TOKEN": "t", GITHUB_API_URL: gh.url, WEIO_API_BASE: "http://127.0.0.1:" + hang.address().port
    };
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {env, cwd: dir});
      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.on("error", reject);
      child.on("close", (code) => resolve({code, stdout}));
    });
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0);
    assert.ok(elapsed >= 14500 && elapsed < 25000, "elapsed " + elapsed);
    const w = result.stdout.split("\n").find((l) => l.startsWith("::warning title=CI Speed Check Pro::"));
    assert.ok(w && /no answer within 15 s/.test(w) && w.includes(BUY_URL), w);
    assert.deepEqual(log, ["runs:1", "credit"]);
  } finally {
    hang.closeAllConnections();
    hang.close();
    await gh.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
