import assert from 'node:assert/strict';
import { inspectDeployment } from '../scripts/check-deployment-config.mjs';
const env = { VERCEL_ENV: 'preview', VERCEL_URL: 'current-preview.vercel.app', PREVIEW_TURSO_DATABASE_URL: 'libsql://test.example', PREVIEW_TURSO_AUTH_TOKEN: 'PRIVATE_TOKEN_SENTINEL', TURSO_DATABASE_URL: 'libsql://prod.example', PUBLIC_APP_URL: 'https://preview.example', OWNER_SETUP_CODE: 'PRIVATE_OWNER_SENTINEL', RESEND_API_KEY: 'email-secret', AUTH_EMAIL_FROM: 'test@example.test', VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'secret', VAPID_SUBJECT: 'mailto:test@example.test', CRON_SECRET: 'cron-secret' };
assert.equal(inspectDeployment(env).readyForServiceTesting, true);
assert.equal(inspectDeployment({}).readyForServiceTesting, false);
for (const override of [{PREVIEW_TURSO_DATABASE_URL: env.TURSO_DATABASE_URL}, {PREVIEW_TURSO_DATABASE_URL:'file:local.db'}, {VERCEL_URL:'http://localhost:3200'}, {ALLOW_LOCAL_DEMO_AUTH:'true'}, {RAZORPAY_ENABLED:'true',RAZORPAY_KEY_ID:'rzp_live_test'}, {SMS_OTP_ENABLED:'true'}, {CRON_SECRET:''}, {RESEND_API_KEY:''}]) assert.equal(inspectDeployment({...env,...override}).readyForServiceTesting,false);
assert.doesNotMatch(JSON.stringify(inspectDeployment(env)), /PRIVATE_TOKEN_SENTINEL|PRIVATE_OWNER_SENTINEL|email-secret|cron-secret/);
console.log('Deployment configuration checks passed: isolation, missing services, preview live-payment rejection and secret redaction.');

const integration = {...env, PREVIEW_TURSO_DATABASE_URL:'', PREVIEW_TURSO_AUTH_TOKEN:'', YAADRAKHO_TEST_TURSO_DATABASE_URL:'libsql://integration.example',YAADRAKHO_TEST_TURSO_AUTH_TOKEN:'secret'};
assert.equal(inspectDeployment(integration).readyForServiceTesting,true);
assert.equal(inspectDeployment({...integration,YAADRAKHO_TEST_TURSO_AUTH_TOKEN:'',PREVIEW_TURSO_AUTH_TOKEN:'wrong-pair'}).readyForServiceTesting,false);

// Preview email/document links use the current deployment, not a stale shared URL.
for (const PUBLIC_APP_URL of ['', 'https://removed-preview.vercel.app', 'http://localhost:3200']) {
  assert.equal(inspectDeployment({...env, PUBLIC_APP_URL}).readyForServiceTesting, true);
}
for (const VERCEL_URL of ['', 'https://current-preview.vercel.app', 'current-preview.vercel.app/path', 'current-preview.vercel.app.evil.test']) {
  assert.equal(inspectDeployment({...env, VERCEL_URL}).readyForServiceTesting, false);
}
const production = {...env, VERCEL_ENV:'production', TURSO_AUTH_TOKEN:'private', PUBLIC_APP_URL:'https://app.example.test'};
assert.equal(inspectDeployment(production).readyForServiceTesting, true);
for (const PUBLIC_APP_URL of ['https://app.example.test/path', 'https://app.example.test?query=1', 'https://app.example.test#fragment', 'https://user:pass@app.example.test']) {
  assert.equal(inspectDeployment({...production, PUBLIC_APP_URL}).readyForServiceTesting, false);
}
console.log('Public-link preflight checks passed for Preview identity and Production origin.');
