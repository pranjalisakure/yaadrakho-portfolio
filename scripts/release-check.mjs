import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run serially: integration suites own separate synthetic fixture databases.
const checks = [
  ['Database backup and restore', ['tests/database-backup.integration.mjs']],
  ['OTP schema migration', ['tests/email-reset-migration.test.mjs']],
  ['Verification resend feedback', ['--import','tsx','tests/verification-feedback.integration.ts']],
  ['OTP recovery', ['--import','tsx','tests/email-password-reset.integration.ts']],
  ['Account and ledger isolation', ['--import','tsx','tests/phase9.integration.ts']],
  ['Local account recovery', ['--import','tsx','tests/local-demo-auth.integration.ts']],
  ['Billing and pagination', ['--import','tsx','tests/billing.integration.ts']],
  ['Payment QR rules', ['--import','tsx','tests/payment-qr.integration.ts']],
  ['Payment recovery', ['--import','tsx','tests/order-recovery.integration.ts']],
  ['Reminder delivery logic', ['--import','tsx','tests/reminders.integration.ts']],
  ['Reminder customer selection', ['--import','tsx','tests/reminder-customer.test.ts']],
  ['Notification navigation', ['tests/notification-navigation.test.mjs']],
  ['Notification registration', ['--import','tsx','tests/notification-client.integration.ts']],
  ['Preview database isolation', ['tests/preview-database.test.mjs']],
  ['Deployment preflight tests', ['tests/deployment-config.test.mjs']],
  ['Public URL selection', ['--import','tsx','--test','tests/public-app-url.test.ts']],
];
if (!process.env.npm_execpath) throw Error('Run using npm run test:release');
checks.push(['Runtime dependency security',[process.env.npm_execpath,'audit','--omit=dev','--audit-level=high']]);
checks.push(['Production build',[process.env.npm_execpath,'run','build']]);
checks.push(['Lint',[process.env.npm_execpath,'run','lint']]);
const results=[];
const env={...process.env};
for(const key of Object.keys(env)) {
  if (/^(VERCEL|TURSO_|PREVIEW_TURSO_|YAADRAKHO_TEST_TURSO_|RESEND_|RAZORPAY_|VAPID_|WHATSAPP_)/.test(key) || ['DATABASE_URL','AUTH_EMAIL_FROM','CRON_SECRET','OWNER_SETUP_CODE','PUBLIC_APP_URL'].includes(key)) delete env[key];
}
mkdirSync('outputs',{recursive:true});
mkdirSync('backups',{recursive:true});
for (const [name,args] of checks) {
  console.log('\nChecking: '+name);
  const start=Date.now();
  const result=spawnSync(process.execPath,args,{stdio:'inherit',env,timeout:15*60_000});
  results.push({name,passed:result.status===0,exitCode:result.status,signal:result.signal,error:result.error?.message,seconds:Math.round((Date.now()-start)/1000)});
  writeFileSync(resolve('outputs/release-checks.json'),JSON.stringify({checkedAt:new Date().toISOString(),scope:'Synthetic local checks; not real provider/device or production readiness',results},null,2));
  if(result.status!==0){console.error('Stopped after failed check: '+name, {exitCode:result.status,signal:result.signal,error:result.error?.message});process.exit(1);}
}
console.log('All automated release checks passed. Real device/provider and remote restore checks remain separate.');
