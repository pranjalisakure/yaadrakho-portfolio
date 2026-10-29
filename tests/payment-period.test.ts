import assert from "node:assert/strict";
import test from "node:test";
import { paymentDueRemaining, paymentPeriodLabel, selectOpenPaymentDue } from "../app/payment-period";

test("formats invoice payment dues without treating them as dates", () => {
  assert.equal(paymentPeriodLabel("invoice:YR-2026-000003"), "Bill YR-2026-000003");
});

test("formats monthly and one-time payment dues", () => {
  assert.equal(paymentPeriodLabel("2026-07"), "July 2026");
  assert.equal(paymentPeriodLabel("one-time:42"), "One-time payment");
});

test("uses a safe fallback for legacy or malformed period keys", () => {
  assert.equal(paymentPeriodLabel(null), "Payment due");
  assert.equal(paymentPeriodLabel("legacy-value"), "Payment due");
});

test("selects the current open due and calculates only its remaining amount", () => {
  const dues = [
    { id: 10, amountDue: 500, amountPaid: 200, status: "partial" },
    { id: 11, amountDue: 700, amountPaid: 0, status: "pending" },
  ];
  const selected = selectOpenPaymentDue(dues, 11);
  assert.equal(selected?.id, 11);
  assert.equal(paymentDueRemaining(selected), 700);
});

test("ignores paid dues and falls back to the first open due", () => {
  const dues = [
    { id: 1, amountDue: 500, amountPaid: 500, status: "paid" },
    { id: 2, amountDue: 300, amountPaid: 50, status: "partial" },
  ];
  const selected = selectOpenPaymentDue(dues, 1);
  assert.equal(selected?.id, 2);
  assert.equal(paymentDueRemaining(selected), 250);
});
