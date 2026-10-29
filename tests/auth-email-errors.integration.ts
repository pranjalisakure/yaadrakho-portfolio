import assert from 'node:assert/strict';
import {sendAccountEmail, AccountEmailError} from '../app/auth-email';
process.env.RESEND_API_KEY='test';process.env.AUTH_EMAIL_FROM='Test <test@example.test>';
const original=globalThis.fetch;
const input={to:'recipient@example.test',displayName:'Test',kind:'verify' as const,actionUrl:'https://example.test/verify'};
try {
 for(const [status,message,code] of [[403,'You can only send testing emails to your own email address','EMAIL_TEST_RECIPIENT_RESTRICTED'],[401,'Invalid key','EMAIL_PROVIDER_SETUP'],[429,'limit','EMAIL_PROVIDER_LIMIT'],[500,'error','EMAIL_PROVIDER_FAILURE']] as const){
 globalThis.fetch=async()=>Response.json({message},{status});
 await assert.rejects(()=>sendAccountEmail(input),e=>e instanceof AccountEmailError && e.code===code);
 }
 globalThis.fetch=async()=>{throw Error('network');};
 await assert.rejects(()=>sendAccountEmail(input),e=>e instanceof AccountEmailError && e.code==='EMAIL_UNAVAILABLE');
 globalThis.fetch=async()=>Response.json({id:'mock'});await sendAccountEmail(input);
} finally {globalThis.fetch=original;}
console.log('Email provider failure classification passed; no email sent.');
