import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const file=resolve('backups/yaadrakho-verification-feedback-test.db');
await rm(file,{force:true});
for(const key of Object.keys(process.env))if(/^(VERCEL|TURSO_|PREVIEW_TURSO_|YAADRAKHO_TEST_TURSO_)/.test(key))delete process.env[key];
process.env.TURSO_DATABASE_URL='file:'+file.replaceAll('\\','/');
process.env.PUBLIC_APP_URL='http://127.0.0.1:3200';
process.env.ALLOW_LOCAL_DEMO_AUTH='true';
process.env.ALLOW_PREVIEW_MANUAL_VERIFICATION='false';
const {POST:signup}=await import('../app/api/auth/signup/route');
const {POST:resend}=await import('../app/api/auth/resend-verification/route');
const {getClient}=await import('../db');
const req=(email:string)=>new Request('http://127.0.0.1:3200/api/auth/resend-verification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
const originalFetch=globalThis.fetch;
let sent=0;
try {
 const created=await signup(new Request('http://127.0.0.1:3200/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayName:'Verification test',email:'verify@example.test',password:'SyntheticOnly123!'})}));
 assert.equal(created.status,201);
 const {localDemoUrl}=await created.json();
 process.env.ALLOW_LOCAL_DEMO_AUTH='false';
 process.env.RESEND_API_KEY='synthetic';process.env.AUTH_EMAIL_FROM='test@example.test';
 globalThis.fetch=async()=>{sent++;return Response.json({id:'synthetic'});};
 const pending=await resend(req('verify@example.test'));assert.equal(pending.status,200);assert.equal(sent,1);
 // Resend replaced the initial verification token. Verify the account without consuming live credentials.
 await getClient().execute("UPDATE users SET email_verified_at = 1 WHERE email = 'verify@example.test'");
 assert.ok(localDemoUrl);
 const verified=await resend(req('verify@example.test'));assert.equal(verified.status,200);assert.equal(sent,1);
 const missing=await resend(req('missing@example.test'));assert.equal(missing.status,200);assert.equal(sent,1);
 assert.deepEqual(await verified.json(),await missing.json(),'Public response must not reveal account existence or verification status');
 await resend(req('verify@example.test'));
 const limited=await resend(req('verify@example.test'));assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'900');assert.equal(sent,1);
 assert.match((await limited.json()).error,/Wait 15 minutes/);
 await getClient().execute("UPDATE users SET email_verified_at = NULL WHERE email = 'verify@example.test'");
 await getClient().execute("DELETE FROM auth_requests WHERE request_key = 'verify:verify@example.test'");
 globalThis.fetch=async()=>Response.json({message:'provider unavailable'},{status:500});
 assert.equal((await resend(req('verify@example.test'))).status,503);
 console.log('Verification feedback passed: eligible send, verified/missing no-send, private response, explicit rate limit and provider failure.');
}finally{globalThis.fetch=originalFetch;await getClient().close();}
