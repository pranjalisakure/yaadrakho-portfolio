import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ensureAuthTables, getClient } from "../db";
import { findUserByEmail } from "./auth";
import { sendAccountEmail } from "./auth-email";
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
export async function requestEmailReset(email: string) {
  await ensureAuthTables();
  const challenge = randomBytes(32).toString("hex");
  const user = await findUserByEmail(email);
  if (!user || user.email_verified_at === null) return challenge;
  const otp = String(randomInt(1_000_000)).padStart(6, "0");
  const db = getClient();
  await db.execute({sql: "DELETE FROM email_reset_challenges WHERE expires_at <= ?", args: [Date.now()]});
  await db.execute({sql: `INSERT INTO email_reset_challenges (challenge_hash,user_id,otp_hash,password_version,expires_at)
    VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET challenge_hash=excluded.challenge_hash,otp_hash=excluded.otp_hash,password_version=excluded.password_version,expires_at=excluded.expires_at,attempts=0,delivered=0`,
    args: [hash(challenge),user.id,hash(challenge+":"+otp),user.password_hash,Date.now()+600_000]});
  try {
    await sendAccountEmail({to: user.email, displayName: user.display_name, kind: "reset", actionUrl: "", otp});
    await db.execute({sql: "UPDATE email_reset_challenges SET delivered=1 WHERE challenge_hash=?",args:[hash(challenge)]});
  } catch(error) {
    await db.execute({sql:"DELETE FROM email_reset_challenges WHERE challenge_hash=?",args:[hash(challenge)]});
    throw error;
  }
  return challenge;
}
async function resetTransaction() {
  for(let attempt=0;;attempt++) {
    try {return await getClient().transaction("write");}
    catch(error) {if(attempt>=4 || !(error instanceof Error) || !("code" in error) || error.code!=="SQLITE_BUSY") throw error; await new Promise(resolve=>setTimeout(resolve,50));}
  }
}
export async function verifyEmailReset(challenge: string, otp: string) {
  await ensureAuthTables();
  const tx = await resetTransaction();
  try {
    const now=Date.now();
    const row=(await tx.execute({sql:`SELECT c.*, u.password_hash AS current_password FROM email_reset_challenges c JOIN users u ON u.id=c.user_id
      WHERE c.challenge_hash=? AND c.expires_at>? AND c.attempts<5 AND c.delivered=1 AND u.email_verified_at IS NOT NULL`,args:[hash(challenge),now]})).rows[0];
    if(!row) return null;
    await tx.execute({sql:"UPDATE email_reset_challenges SET attempts=attempts+1 WHERE challenge_hash=?",args:[hash(challenge)]});
    if(row.password_version!==row.current_password || !timingSafeEqual(Buffer.from(String(row.otp_hash)),Buffer.from(hash(challenge+":"+otp)))) {
      await tx.commit(); return null;
    }
    const token=randomBytes(32).toString("hex");
    await tx.execute({sql:"DELETE FROM email_reset_challenges WHERE challenge_hash=?",args:[hash(challenge)]});
    await tx.execute({sql:"DELETE FROM account_tokens WHERE user_id=? AND purpose='reset_password'",args:[Number(row.user_id)]});
    await tx.execute({sql:"INSERT INTO account_tokens(user_id,purpose,token_hash,expires_at,used_at,created_at) VALUES (?,'reset_password',?,?,NULL,?)",args:[Number(row.user_id),hash(token),now+300_000,now]});
    await tx.commit(); return token;
  } finally { tx.close(); }
}
