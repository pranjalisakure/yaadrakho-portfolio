import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("contains the YaadRakho landing page and safe mobile customer saving", async () => {
  const [page, dashboard, authForm, auth, manifest, serviceWorker, customerRoute, hosting, pushReminders, workflow, monthlyPayments, paymentLedger, adminRoute, adminAnalytics, customerBill, ownerInvoice] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AuthForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/customers/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../app/push-reminders.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/datewise-reminders.yml", import.meta.url), "utf8"),
    readFile(new URL("../app/api/customers/[id]/payments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/payment-ledger.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/admin-analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/bill/[token]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/invoices/[id]/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /Open App/);
  assert.match(page, /Never forget a customer/);
  assert.match(page, /How it works/);
  assert.match(page, /Free early access/);
  assert.match(page, /No trial expiry/);
  assert.match(dashboard, /playReminderTone/);
  assert.match(dashboard, /Test reminder ringtone/);
  assert.match(dashboard, /Extra sound-notification times/);
  assert.match(dashboard, /Monthly recurring payment/);
  assert.match(dashboard, /Mark month paid/);
  assert.match(dashboard, /Monthly ledger/);
  assert.match(monthlyPayments, /recordLedgerPayment/);
  assert.match(paymentLedger, /nextMonthlyDue/);
  assert.match(paymentLedger, /customer_payments/);
  assert.match(paymentLedger, /payment_status = 'pending'/);
  assert.match(pushReminders, /compulsoryReminderHours/);
  assert.match(pushReminders, /push_delivery_items/);
  assert.match(pushReminders, /push_delivery_claims/);
  assert.match(workflow, /cron: "30 3 \* \* \*"/);
  assert.match(workflow, /cron: "30 15 \* \* \*"/);
  assert.match(dashboard, /Business profile/);
  assert.match(dashboard, /Sign out of YaadRakho/);
  assert.match(dashboard, /navigator\.contacts\.select|contacts\.select/);
  assert.match(dashboard, /Select from phone contacts/);
  assert.match(dashboard, /Open existing customer/);
  assert.match(dashboard, /duplicateOfId/);
  assert.match(dashboard, /normalizeCustomer/);
  assert.match(dashboard, /Date unavailable/);
  assert.match(auth, /PASSWORD_ITERATIONS = 100_000/);
  assert.doesNotMatch(auth, /PASSWORD_ITERATIONS = 210_000/);
  assert.doesNotMatch(page, /signin-with-chatgpt|ChatGPT sign-in/);
  assert.match(authForm, /Create your free account/);
  assert.match(authForm, /recovery code/i);
  assert.match(authForm, /Forgot password\? Email me a reset link/);
  assert.match(authForm, /Resend verification email/);
  assert.match(auth, /email_verified_at/);
  assert.match(auth, /replacePasswordWithToken/);
  assert.match(manifest, /YaadRakho Customer Tracker/);
  assert.match(manifest, /"display": "standalone"/);
  assert.doesNotMatch(dashboard, /new Notification\s*\(/);
  assert.match(dashboard, /credentials: "same-origin"/);
  assert.match(dashboard, /response\.headers\.get\("content-type"\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /registration\.showNotification/);
  assert.match(serviceWorker, /action: "call"/);
  assert.match(serviceWorker, /action: "whatsapp"/);
  assert.match(dashboard, /Send test notification/);
  assert.match(dashboard, /YaadRakho reminder test/);
  assert.match(dashboard, /registration\.showNotification/);
  assert.match(dashboard, /Notification permission not given/);
  assert.match(dashboard, /Chrome → Site settings → Notifications → Allow/);
  assert.match(dashboard, /due date/);
  assert.match(dashboard, /showSavedCustomerReminder/);
  assert.match(dashboard, /closeCustomerReminder/);
  assert.match(dashboard, /marked converted successfully/);
  assert.match(serviceWorker, /CLOSE_CUSTOMER_REMINDER/);
  assert.match(serviceWorker, /data\.notifications/);
  assert.match(customerRoute, /Customer could not be verified after saving/);
  assert.match(customerRoute, /This customer already exists/);
  assert.match(customerRoute, /phoneKey/);
  assert.doesNotMatch(customerRoute, /trialEndsAt|customerLimit|trial has ended/);
  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.match(dashboard, /Owner dashboard/);
  assert.match(dashboard, /YaadRakho SaaS overview/);
  assert.match(dashboard, /Reminder automation/);
  assert.match(adminRoute, /user\.isOwner/);
  assert.match(adminRoute, /Owner access required/);
  assert.match(adminRoute, /private, no-store/);
  assert.match(adminAnalytics, /u\.is_owner = 0/);
  assert.doesNotMatch(adminAnalytics, /password_hash|recovery_hash/);
  assert.match(customerBill, /sellerName/);
  assert.match(ownerInvoice, /sellerName/);
  assert.doesNotMatch(customerBill, /Generated with YaadRakho|YaadRakho Business/);
  assert.doesNotMatch(ownerInvoice, /Generated with YaadRakho|YaadRakho Business/);
});
