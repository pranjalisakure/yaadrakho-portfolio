import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const code = "const {getClient}=await import('./db/index.ts');try{getClient();process.exit(0)}catch{process.exit(2)}";
function check(extra, expected) { const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,TURSO_DATABASE_URL:'libsql://production.example.test',TURSO_AUTH_TOKEN:'',DATABASE_URL:'',YAADRAKHO_TEST_TURSO_DATABASE_URL:'',YAADRAKHO_TEST_TURSO_AUTH_TOKEN:'',PREVIEW_TURSO_DATABASE_URL:'',PREVIEW_TURSO_AUTH_TOKEN:'',...extra}});assert.equal(result.status,expected); }
check({VERCEL_ENV:'preview'},2);
check({VERCEL_ENV:'preview',PREVIEW_TURSO_DATABASE_URL:'libsql://production.example.test'},2);
check({VERCEL_ENV:'preview',PREVIEW_TURSO_DATABASE_URL:'libsql://preview.example.test'},0);
check({VERCEL_ENV:'production'},0);
console.log('Preview database isolation gates passed without connecting to a database.');

check({VERCEL_ENV:'preview',YAADRAKHO_TEST_TURSO_DATABASE_URL:'libsql://integration.example.test'},0);
check({VERCEL_ENV:'preview',YAADRAKHO_TEST_TURSO_DATABASE_URL:'libsql://production.example.test'},2);
