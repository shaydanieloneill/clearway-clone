// Pure logic for turning a Retell call_analyzed payload into SMS/email
// content. No env vars, no network, no side effects — kept separate from
// server.js so it can be unit tested directly.

function normalizeUkNumber(raw) {
  if (!raw || typeof raw !== "string") return null;
  let n = raw.replace(/[\s\-().]/g, "");
  if (n.startsWith("+")) return n; // already E.164
  if (n.startsWith("00")) return "+" + n.slice(2); // 0044... → +44...
  if (n.startsWith("0")) return "+44" + n.slice(1); // 07700... → +447700...
  if (n.startsWith("44")) return "+" + n;
  return null; // can't confidently normalize
}

// Friendly display for SMS: keep E.164 (tap-to-call works on UK phones)
function displayNumber(raw) {
  return normalizeUkNumber(raw) || raw || "unknown number";
}

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string")
    return ["true", "yes", "urgent", "1"].includes(v.toLowerCase().trim());
  return false;
}

// Structural UK postcode check — catches obvious garbage (e.g. "R2T R2")
// without needing a network call. Deliberately permissive: matches the
// standard outward+inward shape, tolerant of a missing/extra space.
function isValidUkPostcodeFormat(postcode) {
  if (!postcode || typeof postcode !== "string") return false;
  const cleaned = postcode.trim().toUpperCase();
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/.test(cleaned);
}

// Soft existence check via postcodes.io (free, no key). Returns true/false
// when it can tell, or null if the postcode is unset or the lookup itself
// failed/was unreachable — null must NEVER be treated as "invalid", since
// that would falsely alarm on a network hiccup or a postcode the dataset
// simply doesn't have yet (e.g. a brand new development).
async function checkPostcodeExists(postcode) {
  if (!postcode || typeof postcode !== "string") return null;
  try {
    const res = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode.trim())}/validate`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.result === "boolean" ? data.result : null;
  } catch {
    return null;
  }
}

function extractEnquiry(call) {
  const analysis = call.call_analysis || {};
  const data = analysis.custom_analysis_data || {};

  const name = pick(data, ["customer_name", "caller_name", "name"]);
  const job = pick(data, [
    "job_description",
    "job_summary",
    "job_type",
    "issue",
    "problem",
  ]);
  const postcode = pick(data, ["postcode", "post_code", "address", "location"]);
  const postcodeUnclear = truthy(pick(data, ["postcode_unclear"]));
  const callbackTime = pick(data, [
    "callback_time",
    "best_time_to_call",
    "availability",
  ]);
  const urgent = truthy(
    pick(data, ["is_urgent", "urgent", "urgency", "emergency"])
  );

  const durationSec = call.duration_ms
    ? Math.round(call.duration_ms / 1000)
    : call.start_timestamp && call.end_timestamp
      ? Math.round((call.end_timestamp - call.start_timestamp) / 1000)
      : null;

  // Anything other than a normal hangup/transfer suggests the call was cut short
  const normalEndings = [
    "user_hangup",
    "agent_hangup",
    "call_transfer",
    "transfer_bridged",
  ];
  const cutShort =
    call.disconnection_reason &&
    !normalEndings.includes(call.disconnection_reason);

  const postcodeClean = postcode ? String(postcode).trim().toUpperCase() : null;
  const postcodeFormatValid = postcodeClean
    ? isValidUkPostcodeFormat(postcodeClean)
    : false;

  const missing = [];
  if (!name) missing.push("name");
  if (!job) missing.push("job description");
  if (!postcode) missing.push("postcode");
  else if (!postcodeFormatValid) missing.push("postcode (unusual format — please confirm)");
  else if (postcodeUnclear) missing.push("postcode (agent unsure — please confirm)");

  return {
    callerNumber: displayNumber(call.from_number),
    name: name ? String(name).trim() : null,
    job: job ? String(job).trim() : null,
    postcode: postcodeClean,
    postcodeFormatValid,
    postcodeUnclear,
    callbackTime: callbackTime ? String(callbackTime).trim() : null,
    urgent,
    durationSec,
    cutShort,
    disconnectionReason: call.disconnection_reason || null,
    summary: analysis.call_summary || null,
    missing,
    needsReview: missing.length > 0 || cutShort,
  };
}

function formatSms(e) {
  const name = e.name || "Name not captured";
  const postcode = e.postcode || "no postcode";
  const job = e.job || e.summary || "job details not captured";
  // Keep the job line short so the SMS stays within ~2 segments
  const jobLine = job.length > 140 ? job.slice(0, 137) + "..." : job;

  let msg;
  if (e.urgent) {
    msg = `\u{1F534} URGENT — ${name}, ${e.callerNumber}. ${postcode}. ${jobLine}. Wants call-back ASAP.`;
  } else {
    msg = `New enquiry — ${name}, ${e.callerNumber}. ${postcode}. ${jobLine}.`;
    if (e.callbackTime) msg += ` Call back: ${e.callbackTime}.`;
  }
  if (e.needsReview) {
    msg += ` ⚠️ Needs review — ${
      e.cutShort ? "call cut short" : "missing " + e.missing.join(", ")
    }. Full details in email.`;
  }
  return msg;
}

function formatEmail(e, call, customer, postcodeExists) {
  const rows = [
    ["Caller", e.name || "Not captured"],
    ["Phone", e.callerNumber],
    ["Postcode / address", e.postcode || "Not captured"],
    ["Job", e.job || "Not captured"],
    ["Urgent", e.urgent ? "YES" : "No"],
    ["Preferred call-back time", e.callbackTime || "Not given"],
    ["Call duration", e.durationSec != null ? `${e.durationSec}s` : "Unknown"],
    ["Call ended", e.disconnectionReason || "Unknown"],
    ["Call summary", e.summary || "None"],
    ["Retell call ID", call.call_id || "Unknown"],
  ];
  // Soft, non-alarming note — only shown when the lookup positively found no
  // match (never for a network hiccup or "couldn't check", which is null).
  // Deliberately left out of the SMS entirely — a false alarm on every text
  // would make the product look broken rather than helpful.
  if (postcodeExists === false) {
    rows.push([
      "Postcode check",
      "Not found in the postcode lookup — might be worth double-checking with the customer, but could just be a newer address not in the database yet.",
    ]);
  }
  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px;font-weight:bold;">${k}</td><td style="padding:6px 12px;">${v}</td></tr>`
    )
    .join("");
  const banner = e.urgent
    ? `<p style="color:#c00;font-weight:bold;">\u{1F534} URGENT — customer wants a call-back ASAP</p>`
    : "";
  const review = e.needsReview
    ? `<p style="color:#b60;font-weight:bold;">⚠️ Needs review: ${
        e.cutShort
          ? "the call may have been cut short (" + e.disconnectionReason + ")"
          : "missing " + e.missing.join(", ")
      }. Check the Retell dashboard for the transcript.</p>`
    : "";
  return {
    subject: `${e.urgent ? "\u{1F534} URGENT enquiry" : "New enquiry"} — ${
      e.name || e.callerNumber
    }${e.postcode ? " (" + e.postcode + ")" : ""}`,
    html: `
      <h2>New phone enquiry for ${customer.businessName}</h2>
      ${banner}${review}
      <table border="0" cellspacing="0" style="border:1px solid #ddd;">${table}</table>
      <p style="color:#888;font-size:12px;">Sent automatically by Clearway AI.</p>`,
  };
}

module.exports = {
  normalizeUkNumber,
  displayNumber,
  pick,
  truthy,
  isValidUkPostcodeFormat,
  checkPostcodeExists,
  extractEnquiry,
  formatSms,
  formatEmail,
};
