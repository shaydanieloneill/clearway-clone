// Clearway AI — Retell → Twilio SMS bridge
//
// Receives Retell's "call_analyzed" webhook after each call, extracts the enquiry
// details captured by the voice agent, and:
//   1. Sends an SMS to the tradesperson (Twilio)
//   2. Sends a fuller email backup (Resend)
//   3. Appends a log line to logs/calls.jsonl
//
// Endpoints:
//   POST /webhook/retell  — point Retell's webhook here
//   GET  /health          — liveness check

const express = require("express");
const fs = require("fs");
const path = require("path");
const Retell = require("retell-sdk").default || require("retell-sdk");
const twilio = require("twilio");
const {
  normalizeUkNumber,
  checkPostcodeExists,
  extractEnquiry,
  formatSms,
  formatEmail,
} = require("./lib/enquiry");
const { findCustomer } = require("./lib/customers");

// Load a local .env file if present (deployment platforms inject env vars directly)
try {
  const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // no .env file — fine in production
}

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  RETELL_API_KEY,
  TEST_SECRET,
  DRY_RUN,
  PORT,
} = process.env;

const dryRun = String(DRY_RUN).toLowerCase() === "true";
const port = Number(PORT) || 3000;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ---------------------------------------------------------------------------
// Customer config: maps the Twilio number the caller dialled → tradesperson.
// ---------------------------------------------------------------------------
const customersPath = path.join(__dirname, "config", "customers.json");
let customers = {};
try {
  customers = JSON.parse(fs.readFileSync(customersPath, "utf8"));
} catch (err) {
  console.error(`Could not read ${customersPath}: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------
async function sendSms(to, body) {
  if (dryRun) {
    console.log(`[DRY RUN] SMS to ${to}: ${body}`);
    return { ok: true, dryRun: true };
  }
  if (!twilioClient || !TWILIO_FROM_NUMBER)
    return { ok: false, error: "Twilio not configured (check env vars)" };

  const attempt = () =>
    twilioClient.messages.create({ to, from: TWILIO_FROM_NUMBER, body });

  try {
    const msg = await attempt();
    return { ok: true, sid: msg.sid };
  } catch (err1) {
    console.error(`SMS attempt 1 failed: ${err1.message} — retrying in 2s`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const msg = await attempt();
      return { ok: true, sid: msg.sid, retried: true };
    } catch (err2) {
      return { ok: false, error: `SMS failed twice: ${err2.message}` };
    }
  }
}

async function sendEmail(to, subject, html) {
  if (dryRun) {
    console.log(`[DRY RUN] Email to ${to}: ${subject}`);
    return { ok: true, dryRun: true };
  }
  if (!RESEND_API_KEY)
    return { ok: false, error: "Resend not configured (RESEND_API_KEY missing)" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL || "Clearway AI <onboarding@resend.dev>",
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: `Email failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Logging — one JSON line per call in calls.jsonl.
// Written to the persistent Railway volume at /data if present, so history
// survives redeploys; falls back to a local logs/ folder for local dev.
// ---------------------------------------------------------------------------
const logsDir = fs.existsSync("/data") ? "/data" : path.join(__dirname, "logs");
fs.mkdirSync(logsDir, { recursive: true });
const logFilePath = path.join(logsDir, "calls.jsonl");

function logCall(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  console.log(`CALL LOG: ${line}`);
  try {
    fs.appendFileSync(logFilePath, line + "\n");
  } catch (err) {
    console.error(`Could not write log file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Idempotency — skip a call_id we've already processed (e.g. a webhook
// delivered twice). Rebuilt from the persisted log on startup so a restart
// doesn't lose the guard.
// ---------------------------------------------------------------------------
const processedCallIds = new Set();
try {
  const existing = fs.readFileSync(logFilePath, "utf8");
  for (const line of existing.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.callId) processedCallIds.add(obj.callId);
    } catch {}
  }
} catch {}

// ---------------------------------------------------------------------------
// Web server
// ---------------------------------------------------------------------------
const app = express();
// Keep the raw body so we can verify Retell's signature
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
// Twilio's usage-trigger callback is form-encoded, not JSON
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    dryRun,
    customersConfigured: Object.keys(customers).filter((k) => k !== "DEFAULT" && !k.startsWith("_"))
      .length,
    twilioConfigured: Boolean(twilioClient && TWILIO_FROM_NUMBER),
    emailConfigured: Boolean(RESEND_API_KEY),
    signatureVerification: Boolean(RETELL_API_KEY),
  });
});

// Twilio calls this when a configured spend/usage trigger fires — relay it
// to the ops contact via the same SMS/email senders used for enquiries.
app.post("/webhook/twilio-usage-alert", async (req, res) => {
  res.status(200).send("ok");
  const { UsageCategory, TriggerValue, RecordedUsage, RecordedUsageUnit } = req.body || {};
  const msg = `⚠️ Twilio usage alert: ${UsageCategory || "usage"} reached ${RecordedUsage || "?"} ${RecordedUsageUnit || ""} (trigger set at ${TriggerValue || "?"}). Check your Twilio console.`;
  logCall({ type: "twilio_usage_alert", body: req.body });
  const ops = customers["DEFAULT"];
  const opsNumber = ops && normalizeUkNumber(ops.smsTo);
  if (opsNumber) await sendSms(opsNumber, msg);
  if (ops && ops.emailTo)
    await sendEmail(ops.emailTo, "Twilio usage alert", `<p>${msg}</p>`);
});

app.post("/webhook/retell", async (req, res) => {
  const isTestRequest =
    TEST_SECRET && req.headers["x-test-secret"] === TEST_SECRET;

  // Verify the request really came from Retell (skipped for manual tests)
  if (RETELL_API_KEY && !isTestRequest) {
    const signature = req.headers["x-retell-signature"];
    const valid =
      signature &&
      Retell.verify &&
      Retell.verify(req.rawBody, RETELL_API_KEY, signature);
    if (!valid) {
      console.error("Rejected webhook: invalid or missing x-retell-signature");
      return res.status(401).json({ error: "invalid signature" });
    }
  }

  const { event, call } = req.body || {};

  // Retell sends call_started, call_ended AND call_analyzed to the same URL.
  // Only call_analyzed contains the captured enquiry data — acknowledge the rest.
  if (event !== "call_analyzed") {
    return res.status(204).end();
  }
  if (!call) {
    logCall({ error: "call_analyzed event with no call object", body: req.body });
    return res.status(400).json({ error: "missing call object" });
  }

  // Skip a call_id we've already processed — protects against a webhook
  // being delivered more than once (network retry, platform re-send, etc.)
  if (processedCallIds.has(call.call_id)) {
    logCall({ callId: call.call_id, duplicate: true, note: "Skipped — already processed" });
    return res.status(200).json({ received: true, duplicate: true });
  }
  processedCallIds.add(call.call_id);

  // Respond to Retell immediately (they time out after 10s and retry),
  // then do the SMS/email work.
  res.status(200).json({ received: true });

  const customer = findCustomer(customers, call.to_number, call.agent_id);
  if (!customer) {
    logCall({
      callId: call.call_id,
      toNumber: call.to_number,
      agentId: call.agent_id,
      error: `No customer mapping for ${call.to_number} / ${call.agent_id} — add it to config/customers.json`,
    });
    return;
  }

  const enquiry = extractEnquiry(call);
  const smsBody = formatSms(enquiry);
  // Soft existence check — best-effort, never blocks or throws; null (unknown)
  // is treated the same as "don't mention it" in formatEmail.
  const postcodeExists = enquiry.postcodeFormatValid
    ? await checkPostcodeExists(enquiry.postcode).catch(() => null)
    : null;
  const email = formatEmail(enquiry, call, customer, postcodeExists);

  const smsTo = normalizeUkNumber(customer.smsTo);
  const smsResult = smsTo
    ? await sendSms(smsTo, smsBody)
    : { ok: false, error: `Invalid smsTo number in config: ${customer.smsTo}` };

  const emailResult = customer.emailTo
    ? await sendEmail(customer.emailTo, email.subject, email.html)
    : { ok: false, error: "No emailTo configured for this customer" };

  logCall({
    callId: call.call_id,
    customer: customer.businessName,
    callerNumber: enquiry.callerNumber,
    captured: {
      name: enquiry.name,
      job: enquiry.job,
      postcode: enquiry.postcode,
      urgent: enquiry.urgent,
      callbackTime: enquiry.callbackTime,
    },
    durationSec: enquiry.durationSec,
    disconnectionReason: enquiry.disconnectionReason,
    needsReview: enquiry.needsReview,
    smsSent: smsResult.ok,
    smsError: smsResult.error || null,
    emailSent: emailResult.ok,
    emailError: emailResult.error || null,
  });

  if (!smsResult.ok)
    console.error(`⚠️ SMS FAILED for call ${call.call_id}: ${smsResult.error}`);
  if (!emailResult.ok)
    console.error(`⚠️ EMAIL FAILED for call ${call.call_id}: ${emailResult.error}`);

  // Failure alert: if either channel failed, best-effort notify the ops
  // contact (DEFAULT entry) so a delivery failure is never purely silent.
  if (!smsResult.ok || !emailResult.ok) {
    const ops = customers["DEFAULT"];
    const opsNumber = ops && normalizeUkNumber(ops.smsTo);
    if (opsNumber) {
      const failed = [!smsResult.ok && "SMS", !emailResult.ok && "email"]
        .filter(Boolean)
        .join(" and ");
      const alertMsg = `⚠️ Clearway bridge alert: ${failed} failed to send for a call from ${customer.businessName}. Check Railway logs (call ${call.call_id}).`;
      sendSms(opsNumber, alertMsg);
    }
  }
});

app.listen(port, () => {
  console.log(`Clearway SMS bridge listening on port ${port}`);
  console.log(`  Dry run:        ${dryRun}`);
  console.log(`  Twilio ready:   ${Boolean(twilioClient && TWILIO_FROM_NUMBER)}`);
  console.log(`  Email ready:    ${Boolean(RESEND_API_KEY)}`);
  console.log(`  Sig verify:     ${Boolean(RETELL_API_KEY)}`);
  console.log(
    `  Customers:      ${Object.keys(customers).filter((k) => k !== "DEFAULT" && !k.startsWith("_")).length} configured`
  );
});
