import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-preview-auth-test.db");
await rm(target, { force: true });
process.env.PREVIEW_TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.TURSO_DATABASE_URL;
delete process.env.YAADRAKHO_TEST_TURSO_DATABASE_URL;
delete process.env.PREVIEW_TURSO_AUTH_TOKEN;
process.env.VERCEL_ENV = "preview";
process.env.ALLOW_PREVIEW_MANUAL_VERIFICATION = "true";
process.env.RESEND_API_KEY = "re_preview_test";
process.env.AUTH_EMAIL_FROM = "YaadRakho <onboarding@resend.dev>";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ message: "test sender rejected" }), {
  status: 403,
  headers: { "Content-Type": "application/json" },
});

const { POST: signup } = await import("../app/api/auth/signup/route");
const { POST: login } = await import("../app/api/auth/login/route");
const { POST: resendVerification } = await import("../app/api/auth/resend-verification/route");
const { findUserByEmail, manuallyVerifyBusinessForPreview } = await import("../app/auth");
const { previewManualVerificationEnabled } = await import("../app/preview-auth");
const { getClient } = await import("../db/index");

const email = "preview-business@example.com";
const password = "PreviewPass123";
const signupResponse = await signup(new Request("https://preview.example.com/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ displayName: "Preview Business", email, password }),
}));
const signupBody = await signupResponse.json() as { manualApprovalPending?: boolean; recoveryCode?: string };
assert.equal(signupResponse.status, 201);
assert.equal(signupBody.manualApprovalPending, true);
assert.ok(signupBody.recoveryCode);

const unverified = await findUserByEmail(email);
assert.ok(unverified, "failed Preview email must retain the business account");
assert.equal(unverified.email_verified_at, null);
assert.equal(previewManualVerificationEnabled(), true);

const resendResponse = await resendVerification(new Request("https://preview.example.com/api/auth/resend-verification", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
}));
const resendBody = await resendResponse.json() as { manualApprovalPending?: boolean; message?: string };
assert.equal(resendResponse.status, 200);
assert.equal(resendBody.manualApprovalPending, true);
assert.match(resendBody.message || "", /owner approval/i);

globalThis.fetch = nativeFetch;
const blockedResponse = await login(new Request("https://preview.example.com/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
}));
assert.equal(blockedResponse.status, 403, "unapproved Preview business must not sign in");

assert.equal(await manuallyVerifyBusinessForPreview(Number(unverified.id)), true);
const loginResponse = await login(new Request("https://preview.example.com/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
}));
assert.equal(loginResponse.status, 200, "owner-approved Preview business should sign in");
assert.match(loginResponse.headers.get("set-cookie") || "", /yaadrakho_session=/);

process.env.VERCEL_ENV = "production";
assert.equal(previewManualVerificationEnabled(), false, "Production must never expose the manual Preview approval flow");

console.log(JSON.stringify({ result: "ok", retainedAfterEmailFailure: true, blockedBeforeApproval: true, loginAfterApproval: true, productionGate: true }));
await getClient().close();
