const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeUkNumber,
  isValidUkPostcodeFormat,
  checkPostcodeExists,
  extractEnquiry,
  formatSms,
  formatEmail,
} = require("../lib/enquiry");

test("normalizeUkNumber handles common UK formats", () => {
  assert.equal(normalizeUkNumber("+447700900123"), "+447700900123");
  assert.equal(normalizeUkNumber("07700 900123"), "+447700900123");
  assert.equal(normalizeUkNumber("07700900123"), "+447700900123");
  assert.equal(normalizeUkNumber("00447700900123"), "+447700900123");
  assert.equal(normalizeUkNumber("447700900123"), "+447700900123");
  assert.equal(normalizeUkNumber(""), null);
  assert.equal(normalizeUkNumber(null), null);
  assert.equal(normalizeUkNumber("not a number"), null);
});

function baseCall(overrides = {}) {
  return {
    call_id: "call_test",
    from_number: "+447911123456",
    disconnection_reason: "user_hangup",
    call_analysis: {
      custom_analysis_data: {
        customer_name: "Sarah Thompson",
        job_description: "Leaking tap",
        postcode: "m20 4wx",
        is_urgent: false,
        callback_time: "After 5pm",
      },
    },
    ...overrides,
  };
}

test("extractEnquiry parses a complete normal call", () => {
  const e = extractEnquiry(baseCall());
  assert.equal(e.name, "Sarah Thompson");
  assert.equal(e.job, "Leaking tap");
  assert.equal(e.postcode, "M20 4WX"); // uppercased
  assert.equal(e.callbackTime, "After 5pm");
  assert.equal(e.urgent, false);
  assert.equal(e.needsReview, false);
  assert.deepEqual(e.missing, []);
});

test("extractEnquiry treats callback_time as a plain string (regression test for C-01)", () => {
  // Retell's field used to be misconfigured as boolean; confirm we handle
  // both a real string and a stray boolean-looking value gracefully.
  const e = extractEnquiry(
    baseCall({
      call_analysis: {
        custom_analysis_data: {
          customer_name: "Test",
          job_description: "Test job",
          postcode: "M1 1AE",
          callback_time: "true", // if the field is ever misconfigured again
        },
      },
    })
  );
  assert.equal(typeof e.callbackTime, "string");
});

test("extractEnquiry flags a postcode the agent marked unclear, even when correctly formatted", () => {
  const e = extractEnquiry(
    baseCall({
      call_analysis: {
        custom_analysis_data: {
          customer_name: "Test",
          job_description: "Test job",
          postcode: "M1 1AE", // valid format, but the agent wasn't confident
          postcode_unclear: true,
        },
      },
    })
  );
  assert.equal(e.postcode, "M1 1AE"); // still captured and used
  assert.equal(e.needsReview, true);
  assert.ok(e.missing.some((m) => m.includes("agent unsure")));
});

test("extractEnquiry does not flag a confidently-captured, correctly-formatted postcode", () => {
  const e = extractEnquiry(baseCall()); // base call has no postcode_unclear flag
  assert.equal(e.needsReview, false);
  assert.deepEqual(e.missing, []);
});

test("extractEnquiry flags missing fields for review", () => {
  const e = extractEnquiry(
    baseCall({
      call_analysis: { custom_analysis_data: { job_description: "Boiler issue" } },
    })
  );
  assert.equal(e.needsReview, true);
  assert.ok(e.missing.includes("name"));
  assert.ok(e.missing.includes("postcode"));
  assert.ok(!e.missing.includes("job description"));
});

test("extractEnquiry flags a call cut short by an abnormal disconnection reason", () => {
  const e = extractEnquiry(baseCall({ disconnection_reason: "error_no_audio_received" }));
  assert.equal(e.cutShort, true);
  assert.equal(e.needsReview, true);
});

test("extractEnquiry does not flag a normal transfer as cut short", () => {
  const e = extractEnquiry(baseCall({ disconnection_reason: "call_transfer" }));
  assert.equal(e.cutShort, false);
});

test("isValidUkPostcodeFormat rejects a pure-digit string (regression: real call gave '894432')", () => {
  assert.equal(isValidUkPostcodeFormat("894432"), false);
  assert.equal(isValidUkPostcodeFormat("89 4432"), false);
});

test("extractEnquiry recognizes urgency from string values, not just booleans", () => {
  for (const value of ["true", "yes", "TRUE", "Yes"]) {
    const e = extractEnquiry(
      baseCall({ call_analysis: { custom_analysis_data: { is_urgent: value } } })
    );
    assert.equal(e.urgent, true, `expected urgency from string value "${value}"`);
  }
  const e = extractEnquiry(
    baseCall({ call_analysis: { custom_analysis_data: { is_urgent: "false" } } })
  );
  assert.equal(e.urgent, false);
});

test("extractEnquiry recognizes urgency from multiple field name spellings", () => {
  for (const key of ["is_urgent", "urgent", "urgency", "emergency"]) {
    const e = extractEnquiry(
      baseCall({ call_analysis: { custom_analysis_data: { [key]: true } } })
    );
    assert.equal(e.urgent, true, `expected urgency from field "${key}"`);
  }
});

test("formatSms produces the urgent red-flag format", () => {
  const e = extractEnquiry(
    baseCall({
      call_analysis: {
        custom_analysis_data: {
          customer_name: "Dave",
          job_description: "Burst pipe",
          postcode: "SW1A 1AA",
          is_urgent: true,
        },
      },
    })
  );
  const sms = formatSms(e);
  assert.match(sms, /^\u{1F534} URGENT/u);
  assert.match(sms, /Wants call-back ASAP/);
});

test("formatSms flags needs-review without failing silently", () => {
  const e = extractEnquiry(
    baseCall({ call_analysis: { custom_analysis_data: {} } })
  );
  const sms = formatSms(e);
  assert.match(sms, /Needs review/);
  assert.match(sms, /missing name, job description, postcode/);
});

test("formatSms truncates a very long job description", () => {
  const longJob = "x".repeat(300);
  const e = extractEnquiry(
    baseCall({
      call_analysis: {
        custom_analysis_data: {
          customer_name: "Test",
          job_description: longJob,
          postcode: "M1 1AE",
        },
      },
    })
  );
  const sms = formatSms(e);
  assert.ok(sms.length < longJob.length + 100, "SMS should be shorter than the raw long job text");
});

test("isValidUkPostcodeFormat accepts well-shaped postcodes", () => {
  assert.equal(isValidUkPostcodeFormat("M1 1AE"), true);
  assert.equal(isValidUkPostcodeFormat("SW1A 1AA"), true);
  assert.equal(isValidUkPostcodeFormat("PR5 5TA"), true);
  assert.equal(isValidUkPostcodeFormat("ER55TA"), true); // no space, still valid shape
  assert.equal(isValidUkPostcodeFormat("m1 1ae"), true); // lowercase ok
});

test("isValidUkPostcodeFormat rejects obvious garbage (regression: Darren's chaotic call)", () => {
  assert.equal(isValidUkPostcodeFormat("R2T R2"), false);
  assert.equal(isValidUkPostcodeFormat(""), false);
  assert.equal(isValidUkPostcodeFormat(null), false);
  assert.equal(isValidUkPostcodeFormat("not a postcode"), false);
});

test("extractEnquiry flags an invalid-format postcode for review without dropping it", () => {
  const e = extractEnquiry(
    baseCall({
      call_analysis: {
        custom_analysis_data: {
          customer_name: "Test",
          job_description: "Test job",
          postcode: "R2T R2",
        },
      },
    })
  );
  assert.equal(e.postcode, "R2T R2"); // still captured, not discarded
  assert.equal(e.postcodeFormatValid, false);
  assert.equal(e.needsReview, true);
  assert.ok(e.missing.some((m) => m.includes("unusual format")));
});

test("extractEnquiry does not flag a well-formed postcode", () => {
  const e = extractEnquiry(baseCall());
  assert.equal(e.postcodeFormatValid, true);
  assert.equal(e.needsReview, false);
});

test("formatSms reuses the existing needs-review wording for bad postcode format (no new scary banner)", () => {
  const e = extractEnquiry(
    baseCall({
      call_analysis: {
        custom_analysis_data: {
          customer_name: "Test",
          job_description: "Test job",
          postcode: "R2T R2",
        },
      },
    })
  );
  const sms = formatSms(e);
  assert.match(sms, /Needs review/);
  assert.doesNotMatch(sms, /POSTCODE UNVERIFIED/i);
});

test("formatEmail adds a soft note only when postcodeExists is explicitly false", () => {
  const e = extractEnquiry(baseCall());
  const customer = { businessName: "Test Biz" };

  const withFalse = formatEmail(e, { call_id: "x" }, customer, false);
  assert.match(withFalse.html, /might be worth double-checking/);

  const withTrue = formatEmail(e, { call_id: "x" }, customer, true);
  assert.doesNotMatch(withTrue.html, /might be worth double-checking/);

  const withNull = formatEmail(e, { call_id: "x" }, customer, null);
  assert.doesNotMatch(withNull.html, /might be worth double-checking/);
});

test("checkPostcodeExists returns null (not false) on a network failure — never a false alarm", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("simulated network failure");
  };
  try {
    const result = await checkPostcodeExists("M1 1AE");
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test("checkPostcodeExists returns null for an empty postcode", async () => {
  assert.equal(await checkPostcodeExists(""), null);
  assert.equal(await checkPostcodeExists(null), null);
});
