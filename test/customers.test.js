const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findCustomer } = require("../lib/customers");

const customers = {
  "+447898115981": { businessName: "Hartley Plumbing & Heating" },
  agent_electrical_demo: { businessName: "Shay's Electrics" },
  DEFAULT: { businessName: "Clearway AI (unmapped number)" },
};

test("findCustomer matches by dialled number", () => {
  const c = findCustomer(customers, "+447898115981", "agent_unrelated");
  assert.equal(c.businessName, "Hartley Plumbing & Heating");
});

test("findCustomer normalizes the dialled number before matching", () => {
  const c = findCustomer(customers, "07898115981", "agent_unrelated");
  assert.equal(c.businessName, "Hartley Plumbing & Heating");
});

test("findCustomer falls back to matching by agent_id when the number isn't mapped", () => {
  const c = findCustomer(customers, "+449999999999", "agent_electrical_demo");
  assert.equal(c.businessName, "Shay's Electrics");
});

test("findCustomer falls back to DEFAULT when neither number nor agent_id match", () => {
  const c = findCustomer(customers, "+449999999999", "agent_unrelated");
  assert.equal(c.businessName, "Clearway AI (unmapped number)");
});

test("findCustomer returns null when there is no DEFAULT and nothing matches", () => {
  const c = findCustomer({ "+447898115981": {} }, "+449999999999", "agent_unrelated");
  assert.equal(c, null);
});
