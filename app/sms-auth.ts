import { createHash, randomBytes } from "node:crypto";
import { ensureAuthTables, getClient } from "../db";
import { checkAuthRequestLimit, findUserByEmail, verifyUserPassword, type AppUser } from "./auth";
import { configuredSmsProvider, type SmsProvider } from "./sms-provider";

type Purpose = "enroll" | "login" | "reset";
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
export function normalizeMobile(value: unknown) {
  const digits = String(value || "").replace(/[\s()-]/g, "");
  const phone = /^[6-9]\d{9}$/.test(digits) ? "+91" + digits : /^91[6-9]\d{9}$/.test(digits) ? "+" + digits : digits;
  if (!/^\+91[6-9]\d{9}$/.test(phone)) throw new Error("Enter a valid Indian mobile number");
  return phone;
}
export function smsPurpose(value: unknown): Purpose {
  if (value !== "enroll" && value !== "login" && value !== "reset") throw new Error("Invalid OTP purpose");
  return value;
}

export async function startSmsChallenge(input: { phone: unknown; purpose: Purpose; password?: string }, actor: AppUser | null, provider: SmsProvider = configuredSmsProvider()) {
  await ensureAuthTables();
  const phone = normalizeMobile(input.phone), purpose = smsPurpose(input.purpose);
  if (purpose === "enroll" && !actor) throw new Error("Sign in before linking a mobile number");
  if (!(await checkAuthRequestLimit("sms-phone", phone)) || !(await checkAuthRequestLimit("sms-global", "all", 60))) throw new Error("Too many OTP requests. Try again in 15 minutes.");
  let userId: number | null = null, passwordVersion = "";
  const db = getClient();
  if (purpose === "enroll") {
    if (!(await checkAuthRequestLimit("sms-enroll", String(actor!.id)))) throw new Error("Too many mobile enrollment attempts. Try again in 15 minutes.");
    const user = await findUserByEmail(actor!.email);
    if (!user || user.id !== actor!.id || user.email_verified_at === null || !(await verifyUserPassword(user, input.password || ""))) throw new Error("Confirm your current password to link a mobile number");
    const occupied = await db.execute({ sql: "SELECT user_id FROM account_phones WHERE phone = ? AND user_id != ?", args: [phone, user.id] });
    if (occupied.rows.length) throw new Error("This mobile number cannot be linked to this account");
    userId = user.id; passwordVersion = user.password_hash;
  } else {
    const user = await db.execute({ sql: "SELECT u.id, u.password_hash FROM users u JOIN account_phones p ON p.user_id = u.id WHERE p.phone = ? AND u.email_verified_at IS NOT NULL", args: [phone] });
    if (user.rows.length) { userId = Number(user.rows[0].id); passwordVersion = String(user.rows[0].password_hash); }
  }
  const token = randomBytes(32).toString("base64url"), now = Date.now();
  await db.batch([
    { sql: "UPDATE sms_challenges SET status = 'superseded' WHERE phone = ? AND status IN ('sending','pending')", args: [phone] },
    { sql: "DELETE FROM sms_challenges WHERE expires_at < ?", args: [now - 86_400_000] },
    { sql: "INSERT INTO sms_challenges (token_hash,user_id,phone,purpose,password_version,expires_at,created_at) VALUES (?,?,?,?,?,?,?)", args: [hash(token), userId, phone, purpose, passwordVersion, now + 10 * 60_000, now] },
  ], "write");
  if (userId) {
    try {
      const sid = await provider.start(phone);
      await db.execute({ sql: "UPDATE sms_challenges SET provider_sid = ?, status = 'pending' WHERE token_hash = ? AND status = 'sending'", args: [sid, hash(token)] });
    } catch {
      await db.execute({ sql: "UPDATE sms_challenges SET status = 'failed' WHERE token_hash = ?", args: [hash(token)] });
      // Same public result for unknown numbers and provider delivery failures.
      if (purpose === "enroll") throw new Error("SMS could not be sent. Please try again later.");
    }
  }
  return { challenge: token, message: purpose === "enroll" ? "Enter the code sent to your mobile. It expires in 10 minutes." : "If this mobile is linked to an account, an OTP has been requested. It expires in 10 minutes." };
}

export async function finishSmsChallenge(token: string, code: string, purpose: Purpose, actor: AppUser | null, provider: SmsProvider = configuredSmsProvider()) {
  await ensureAuthTables();
  smsPurpose(purpose);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\d{4,10}$/.test(code)) throw new Error("Enter a valid OTP");
  const db = getClient(), tokenHash = hash(token), now = Date.now();
  const row = (await db.execute({ sql: "SELECT * FROM sms_challenges WHERE token_hash = ? AND purpose = ? AND status = 'pending' AND attempts < 5 AND expires_at > ?", args: [tokenHash, purpose, now] })).rows[0];
  if (!row || !row.provider_sid || (purpose === "enroll" && (!actor || actor.id !== Number(row.user_id)))) throw new Error("OTP is invalid, expired or already used");
  const claimed = await db.execute({ sql: "UPDATE sms_challenges SET attempts = attempts + 1 WHERE token_hash = ? AND status = 'pending' AND attempts < 5 AND expires_at > ?", args: [tokenHash, now] });
  if (claimed.rowsAffected !== 1) throw new Error("OTP is invalid, expired or already used");
  if (!(await provider.verify(String(row.phone), String(row.provider_sid), code))) throw new Error("OTP is incorrect");
  const tx = await db.transaction("write");
  try {
    const user = (await tx.execute({ sql: "SELECT id FROM users WHERE id = ? AND password_hash = ? AND email_verified_at IS NOT NULL", args: [Number(row.user_id), String(row.password_version)] })).rows[0];
    if (!user) throw new Error("Account changed. Request a new OTP");
    if (purpose !== "enroll") {
      const linked = await tx.execute({ sql: "SELECT user_id FROM account_phones WHERE user_id = ? AND phone = ?", args: [Number(user.id), String(row.phone)] });
      if (!linked.rows.length) throw new Error("Mobile number changed. Request a new OTP");
    }
    const consumed = await tx.execute({ sql: "UPDATE sms_challenges SET status = 'used' WHERE token_hash = ? AND status = 'pending' AND expires_at > ?", args: [tokenHash, Date.now()] });
    if (consumed.rowsAffected !== 1) throw new Error("OTP is invalid, expired or already used");
    let resetToken: string | undefined;
    if (purpose === "enroll") {
      await tx.execute({ sql: "INSERT INTO account_phones (user_id,phone,verified_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,verified_at=excluded.verified_at", args: [Number(user.id), String(row.phone), Date.now()] });
      await tx.execute({ sql: "UPDATE sms_challenges SET status = 'superseded' WHERE user_id = ? AND status IN ('sending','pending')", args: [Number(user.id)] });
      await tx.execute({ sql: "DELETE FROM account_tokens WHERE user_id = ? AND purpose = 'reset_password'", args: [Number(user.id)] });
    } else if (purpose === "reset") {
      resetToken = randomBytes(32).toString("base64url");
      await tx.execute({ sql: "DELETE FROM account_tokens WHERE user_id = ? AND purpose = 'reset_password'", args: [Number(user.id)] });
      await tx.execute({ sql: "INSERT INTO account_tokens (user_id,purpose,token_hash,expires_at,created_at) VALUES (?,'reset_password',?,?,?)", args: [Number(user.id), hash(resetToken), Date.now() + 5 * 60_000, Date.now()] });
    }
    await tx.commit();
    return { userId: Number(user.id), resetToken };
  } finally { tx.close(); }
}
