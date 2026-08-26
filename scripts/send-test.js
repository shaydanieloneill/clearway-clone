// Posts a sample Retell "call_analyzed" payload to your running service so you
// can test SMS/email without making a real phone call.
//
// Usage:
//   npm run test:webhook            → normal enquiry
//   npm run test:webhook:urgent     → urgent enquiry (red-flag SMS format)
//   npm run test:webhook:partial    → call cut short, missing fields ("needs review" path)
//
// Set TARGET_URL to test a deployed instance instead of localhost:
//   TARGET_URL=https://your-app.up.railway.app node scripts/send-test.js urgent

const fs = require("fs");
const path = require("path");

// Reuse the service's .env so TEST_SECRET matches
try {
  const envFile = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {}

const variant = process.argv[2] || "normal";
const url =
  (process.env.TARGET_URL || `http://localhost:${process.env.PORT || 3000}`) +
  "/webhook/retell";

const base = {
  event: "call_analyzed",
  call: {
    call_id: `test_${variant}_${Date.now()}`,
    call_type: "phone_call",
    agent_id: "agent_test123",
    direction: "inbound",
    from_number: "+447911123456",
    to_number: "+441234567890",
    call_status: "ended",
    start_timestamp: Date.now() - 95000,
    end_timestamp: Date.now(),
    duration_ms: 95000,
    disconnection_reason: "user_hangup",
    transcript: "(test transcript)",
    call_analysis: {
      call_summary:
        "Caller reported a leaking tap in the upstairs bathroom and asked for a quote.",
      user_sentiment: "Neutral",
      call_successful: true,
      in_voicemail: false,
      custom_analysis_data: {
        customer_name: "Sarah Thompson",
        job_description: "Leaking tap in upstairs bathroom, drips constantly",
        postcode: "M20 4WX",
        is_urgent: false,
        callback_time: "After 5pm today",
      },
    },
  },
};

if (variant === "urgent") {
  base.call.call_analysis.custom_analysis_data = {
    customer_name: "Dave Bricker",
    job_description: "Burst pipe under kitchen sink, water spreading fast",
    postcode: "SW1A 1AA",
    is_urgent: true,
  };
  base.call.call_analysis.call_summary =
    "Emergency: burst pipe under the kitchen sink, water actively leaking.";
} else if (variant === "partial") {
  // Simulates a caller who hung up early — no name or postcode captured
  base.call.duration_ms = 12000;
  base.call.disconnection_reason = "error_no_audio_received";
  base.call.call_analysis.call_summary = "Call dropped shortly after answering.";
  base.call.call_analysis.call_successful = false;
  base.call.call_analysis.custom_analysis_data = {
    job_description: "Mentioned something about a boiler before the line dropped",
  };
}

(async () => {
  console.log(`POSTing "${variant}" sample payload to ${url} ...`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.TEST_SECRET
          ? { "x-test-secret": process.env.TEST_SECRET }
          : {}),
      },
      body: JSON.stringify(base),
    });
    console.log(`Response: ${res.status} ${await res.text()}`);
    console.log(
      "Now check: your phone for the SMS, your inbox for the email, and logs/calls.jsonl for the log line."
    );
  } catch (err) {
    console.error(
      `Could not reach the service (${err.message}). Is it running? Start it with: npm start`
    );
    process.exit(1);
  }
})();
