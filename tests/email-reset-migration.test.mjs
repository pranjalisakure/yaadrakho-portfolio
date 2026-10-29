import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createClient} from '@libsql/client';
const db=createClient({url:'file::memory:'});
try {
 const sql=await readFile(new URL('../drizzle/0027_email_reset_challenges.sql',import.meta.url),'utf8');
 await db.execute(sql);
 await db.execute("INSERT INTO email_reset_challenges(challenge_hash,user_id,otp_hash,password_version,expires_at) VALUES ('challenge',1,'hash','version',100)");
 await db.execute(sql);
 assert.equal((await db.execute('SELECT * FROM email_reset_challenges')).rows.length,1);
 await assert.rejects(()=>db.execute("INSERT INTO email_reset_challenges(challenge_hash,user_id,otp_hash,password_version,expires_at) VALUES ('other',1,'hash','version',100)"));
 const row=(await db.execute('SELECT * FROM email_reset_challenges')).rows[0];assert.equal(row.attempts,0);assert.equal(row.delivered,0);
 console.log('OTP migration preserves existing challenges and enforces one challenge per account.');
}finally{db.close();}
