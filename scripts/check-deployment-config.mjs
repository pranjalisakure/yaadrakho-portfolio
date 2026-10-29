import { pathToFileURL } from 'node:url';

export function inspectDeployment(env) {
  const checks = [];
  const add = (name, ok, fix) => checks.push({ name, status: ok ? 'configured' : 'action_required', ...(ok ? {} : { action: fix }) });
  const present = (...keys) => keys.every(key => Boolean(env[key]?.trim()));
  const preview = env.VERCEL_ENV === 'preview';
  add('Target environment', ['preview', 'production'].includes(env.VERCEL_ENV), 'Select preview or production explicitly.');
  const db = preview ? (env.YAADRAKHO_TEST_TURSO_DATABASE_URL || env.PREVIEW_TURSO_DATABASE_URL) : env.TURSO_DATABASE_URL || env.DATABASE_URL;
  let remote = false;
  try { const u = new URL(db); remote = u.protocol === 'libsql:' && Boolean(u.hostname); } catch {}
  add('Remote database', remote && present(preview ? (env.YAADRAKHO_TEST_TURSO_DATABASE_URL ? 'YAADRAKHO_TEST_TURSO_AUTH_TOKEN' : 'PREVIEW_TURSO_AUTH_TOKEN') : 'TURSO_AUTH_TOKEN'), preview ? 'Configure PREVIEW_TURSO_DATABASE_URL and PREVIEW_TURSO_AUTH_TOKEN in Preview only.' : 'Configure the production Turso URL and token.');
  if (preview) add('Preview isolation', Boolean(db) && db !== env.TURSO_DATABASE_URL && db !== env.DATABASE_URL, 'Use a separate test database. Different URLs alone do not prove that database contents are isolated.');
  let publicUrl = false;
  if (preview) {
    // Match publicAppUrl: inherited PUBLIC_APP_URL is deliberately ignored.
    // This offline check cannot verify the runtime request-origin fallback.
    publicUrl = /^[a-z0-9-]+\.vercel\.app$/i.test(env.VERCEL_URL?.trim() || '');
  } else {
    try {
      const u = new URL(env.PUBLIC_APP_URL);
      publicUrl = u.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
        && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
    } catch {}
  }
  add('Public links', publicUrl, preview
    ? 'Run this check with the current VERCEL_URL deployment hostname available. Preview ignores PUBLIC_APP_URL; the request-origin fallback cannot be verified offline.'
    : 'Set PUBLIC_APP_URL to the intended HTTPS deployment origin without a path, query, credentials or fragment.');
  add('Local demo disabled', env.ALLOW_LOCAL_DEMO_AUTH !== 'true', 'Disable ALLOW_LOCAL_DEMO_AUTH on deployments.');
  add('Owner registration', present('OWNER_SETUP_CODE'), 'Configure OWNER_SETUP_CODE privately.');
  add('Verification and recovery email', present('RESEND_API_KEY', 'AUTH_EMAIL_FROM'), 'Configure the verified email sender and test actual delivery.');
  add('Device reminders', present('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'CRON_SECRET'), 'Configure push keys and scheduler authorization; then verify scheduled device delivery.');
  if (!preview) add('Preview approval disabled', env.ALLOW_PREVIEW_MANUAL_VERIFICATION !== 'true', 'Disable preview manual verification in Production.');
  if (env.RAZORPAY_ENABLED === 'true') {
    add('Payment credentials', present('RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'), 'Configure all payment credentials privately.');
    if (preview) add('Preview payment mode', env.RAZORPAY_KEY_ID?.startsWith('rzp_test_') && env.RAZORPAY_ALLOW_LIVE !== 'true', 'Use Test Mode keys and disable live payments in Preview.');
  }
  if (env.SMS_OTP_ENABLED === 'true') add('Mobile OTP provider', env.SMS_OTP_PROVIDER === 'twilio_verify' && /^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '') && /^VA[0-9a-f]{32}$/i.test(env.TWILIO_VERIFY_SERVICE_SID || '') && present('TWILIO_AUTH_TOKEN'), 'Complete Twilio Verify configuration before enabling mobile OTP.');
  if (env.WHATSAPP_ACCESS_TOKEN) add('Automatic WhatsApp', present('WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BILL_TEMPLATE_NAME'), 'Configure the approved template and sender before automatic delivery.');
  return { readyForServiceTesting: checks.every(c => c.status === 'configured'), checks, note: 'Configuration presence only: no database connection, message, payment or deployment is performed. Provider delivery, routing, backups and device behavior still need testing.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = inspectDeployment(process.env);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.readyForServiceTesting ? 0 : 2;
}
