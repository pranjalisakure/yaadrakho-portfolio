import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import webpush from 'web-push';

if (process.env.VERCEL || process.env.VERCEL_ENV) throw new Error('Local preview launcher cannot run on Vercel.');
const origin = 'http://127.0.0.1:3200';
const secretFile = resolve('.env.reminders.local');
if (!existsSync(secretFile)) {
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(secretFile, JSON.stringify({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:local-preview@example.test', CRON_SECRET: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' });
}
const secrets = JSON.parse(readFileSync(secretFile, 'utf8'));
for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'CRON_SECRET']) {
  if (typeof secrets[key] !== 'string' || !secrets[key]) throw new Error('Local reminder configuration is incomplete.');
}
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3200'], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, ...secrets, PUBLIC_APP_URL: origin, ALLOW_LOCAL_DEMO_AUTH: 'true', TURSO_DATABASE_URL: `file:${resolve('backups/yaadrakho-auth-preview.db').replaceAll('\\', '/')}`, TURSO_AUTH_TOKEN: '', SMS_OTP_ENABLED: 'false', RAZORPAY_ENABLED: 'false', RESEND_API_KEY: '', WHATSAPP_ACCESS_TOKEN: '' },
});
const hours = new Set(['09', '11', '12', '13', '15', '17', '18', '19', '21']);
let busy = false;
let completed = '';
async function tick() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  if (busy || !hours.has(parts.hour) || Number(parts.minute) > 10) return;
  const slot = `${parts.year}-${parts.month}-${parts.day}-${parts.hour}`;
  if (completed === slot) return;
  busy = true;
  try {
    const response = await fetch(`${origin}/api/cron/reminders?hour=${parts.hour}`, { headers: { authorization: `Bearer ${secrets.CRON_SECRET}` }, signal: AbortSignal.timeout(25_000) });
    if (response.ok) { completed = slot; console.log(`Local reminder slot ${parts.hour}: complete`); }
    else console.warn('Local reminder job will retry:', response.status);
  } catch { console.warn('Local reminder scheduler is waiting for the app.'); }
  finally { busy = false; }
}
const timer = setInterval(() => void tick(), 30_000);
child.on('exit', code => { clearInterval(timer); process.exit(code ?? 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); child.kill(); });
console.log('Local device reminders configured. Keep this preview running for scheduled delivery.');
