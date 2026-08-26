const { normalizeUkNumber } = require("./enquiry");

// Looks up which tradesperson owns a call: by the Twilio number dialled,
// falling back to the Retell agent_id, then to DEFAULT. Kept pure (no fs,
// no env) so it can be unit tested against an in-memory customers map.
function findCustomer(customers, toNumber, agentId) {
  const key = normalizeUkNumber(toNumber) || toNumber;
  return (
    customers[key] ||
    customers[agentId] ||
    customers["DEFAULT"] ||
    null
  );
}

module.exports = { findCustomer };
