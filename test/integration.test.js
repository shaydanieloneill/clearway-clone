// Integration tests: spins up the real server (DRY_RUN, in-memory) and hits
// its actual HTTP endpoints, to catch bugs the unit tests can't (routing,
// duplicate-webhook handling, signature checks, malformed payloads).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { spawn } = require("node:child_process");

const PORT = 3199;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_SECRET = "integration-test-secret";
const tmpLogDir = path.join(__dirname, "tmp_logs");

let serverProcess;

function waitForHealth(retries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      fetch(`${BASE_URL}/health`)
        .then((r) => (r.ok ? resolve() : retry(n)))
        .catch(() => retry(n));
    };
    const retry = (n) => {
      if (n <= 0) return reject(new Error("Server did not become healthy in time"));
      setTimeout(() => attempt(n - 1), 300);
    };
    attempt(retries);
  });
}

before(async () => {
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
  fs.mkdirSync(tmpLogDir, { recursive: true });
  // Point the server's logs dir at a throwaway folder by symlinking is overkill —
  // simplest is to just let it use its default local logs/ dir; the server
  // falls back to <repo>/logs since /data won't exist in this test environment.
  serverProcess = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DRY_RUN: "true",
      TEST_SECRET,
      RETELL_API_KEY: "fake_key_for_signature_tests",
    },
    stdio: "pipe",
  });
  await waitForHealth();
});

after(() => {
  serverProcess.kill();
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
});

function post(path, body, headers = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("GET /health reports ok", async () => {
  const res = await fetch(`${BASE_URL}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
});

test("call_started/call_ended events are acknowledged but ignored", async () => {
  const res = await post(
    "/webhook/retell",
    { event: "call_started", call: { call_id: "x" } },
    { "x-test-secret": TEST_SECRET }
  );
  assert.equal(res.status, 204);
});

test("call_analyzed with no call object returns 400", async () => {
  const res = await post(
    "/webhook/retell",
    { event: "call_analyzed" },
    { "x-test-secret": TEST_SECRET }
  );
  assert.equal(res.status, 400);
});

test("a forged signature is rejected with 401", async () => {
  // Deliberately omit x-test-secret so signature verification actually runs
  const res = await post("/webhook/retell", {
    event: "call_analyzed",
    call: { call_id: "sig_test", from_number: "+447900000000" },
  });
  assert.equal(res.status, 401);
});

test("the same call_id is only processed once (duplicate protection)", async () => {
  const payload = {
    event: "call_analyzed",
    call: {
      call_id: "dup_test_" + Date.now(),
      from_number: "+447911123456",
      to_number: "+447898115981",
      disconnection_reason: "user_hangup",
      call_analysis: { custom_analysis_data: { customer_name: "Test", job_description: "Test", postcode: "M1 1AE" } },
    },
  };
  const first = await post("/webhook/retell", payload, { "x-test-secret": TEST_SECRET });
  const firstBody = await first.json();
  assert.equal(firstBody.duplicate, undefined);

  const second = await post("/webhook/retell", payload, { "x-test-secret": TEST_SECRET });
  const secondBody = await second.json();
  assert.equal(secondBody.duplicate, true);
});

test("an unmapped Twilio number falls back to DEFAULT without crashing", async () => {
  const res = await post(
    "/webhook/retell",
    {
      event: "call_analyzed",
      call: {
        call_id: "unmapped_" + Date.now(),
        from_number: "+447911123456",
        to_number: "+449999999999", // not in customers.json
        call_analysis: { custom_analysis_data: {} },
      },
    },
    { "x-test-secret": TEST_SECRET }
  );
  assert.equal(res.status, 200);
});
