import { deleteWithPaymentGuard } from "../db/payment-deletion";
import { cookies } from "next/headers";
import { ensureAuthTables, getClient, getSqlDatabase } from "../db";
import { OWNER_EMAIL } from "./billing-config";

const SESSION_COOKIE = "yaadrakho_session";
const SESSION_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;
// Kept at 100,000 iterations for compatibility with existing YaadRakho accounts.
const PASSWORD_ITERATIONS = 100_000;

export type AppUser = {
  id: number;
  email: string;
  displayName: string;
  storageKey: string;
  isOwner: boolean;
  emailVerified: boolean;
};

export type UserRow = {
  id: number;
  email: string;
  display_name: string;
  storage_key: string;
  password_salt: string;
  password_hash: string;
  recovery_salt: string;
  recovery_hash: string;
  is_owner: number;
  email_verified_at: number | null;
  last_login_at: number | null;
  last_activity_at: number | null;
};

function database() {
  return getSqlDatabase();
}

function toAppUser(row: UserRow): AppUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    storageKey: row.storage_key,
    isOwner: row.is_owner === 1,
    emailVerified: row.email_verified_at !== null,
  };
}

export function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 160;
}

export function validPassword(password: string) {
  return password.length >= 8 && password.length <= 128;
}

export function verifyOwnerSetupCode(email: string, providedCode: string) {
  if (normalizeEmail(email) !== OWNER_EMAIL.toLowerCase()) return false;
  const ownerSetupCode = process.env.OWNER_SETUP_CODE || "";
  return Boolean(ownerSetupCode && providedCode && safeTextEqual(providedCode, ownerSetupCode));
}

export async function getCurrentUser(): Promise<AppUser | null> {
  await ensureAuthTables();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await database().prepare(`SELECT
      users.id, users.email, users.display_name, users.storage_key,
      users.password_salt, users.password_hash, users.recovery_salt,
      users.recovery_hash, users.is_owner, users.email_verified_at,
      users.last_login_at, users.last_activity_at
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    LIMIT 1`).bind(tokenHash, Date.now()).first<UserRow>();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_activity_at || now - row.last_activity_at > 15 * 60 * 1000) {
    await database().prepare("UPDATE users SET last_activity_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return toAppUser(row);
}

export async function findUserByEmail(email: string) {
  await ensureAuthTables();
  return database().prepare(`SELECT id, email, display_name, storage_key,
    password_salt, password_hash, recovery_salt, recovery_hash, is_owner,
    email_verified_at, last_login_at, last_activity_at
    FROM users WHERE email = ? LIMIT 1`).bind(email).first<UserRow>();
}

export async function registerUser(input: {
  displayName: string;
  email: string;
  password: string;
  ownerSetupCode?: string;
}) {
  await ensureAuthTables();
  const db = database();
  const isOwnerEmail = input.email === OWNER_EMAIL.toLowerCase();
  if (isOwnerEmail && !verifyOwnerSetupCode(input.email, input.ownerSetupCode || "")) {
    throw new Error("The YaadRakho owner setup code is required for this email.");
  }

  const existing = await findUserByEmail(input.email);
  if (existing) throw new Error("An account with this email already exists. Please sign in.");

  const passwordRecord = await createSecretRecord(input.password);
  const recoveryCode = createRecoveryCode();
  const recoveryRecord = await createSecretRecord(recoveryCode);
  const now = Date.now();
  const storageKey = isOwnerEmail ? OWNER_EMAIL.toLowerCase() : `account:${input.email}`;
  const result = await db.prepare(`INSERT INTO users (
      email, display_name, storage_key, password_salt, password_hash,
      recovery_salt, recovery_hash, is_owner, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.email, input.displayName, storageKey, passwordRecord.salt,
      passwordRecord.hash, recoveryRecord.salt, recoveryRecord.hash,
      isOwnerEmail ? 1 : 0, now, now).run();
  const id = Number(result.meta.last_row_id);
  return {
    user: { id, email: input.email, displayName: input.displayName, storageKey, isOwner: isOwnerEmail, emailVerified: false } satisfies AppUser,
    recoveryCode,
  };
}

export async function verifyUserPassword(row: UserRow, password: string) {
  return verifySecret(password, row.password_salt, row.password_hash);
}

export async function verifyRecoveryCode(row: UserRow, recoveryCode: string) {
  return verifySecret(normalizeRecoveryCode(recoveryCode), row.recovery_salt, row.recovery_hash);
}

export async function replacePassword(userId: number, password: string) {
  await ensureAuthTables();
  if (!validPassword(password)) throw new Error("Password must contain 8 to 128 characters.");
  const passwordRecord = await createSecretRecord(password);
  const recoveryCode = createRecoveryCode();
  const recoveryRecord = await createSecretRecord(recoveryCode);
  const db = database();
  await db.batch([
    db.prepare(`UPDATE users SET password_salt = ?, password_hash = ?, recovery_salt = ?, recovery_hash = ?, updated_at = ? WHERE id = ?`)
      .bind(passwordRecord.salt, passwordRecord.hash, recoveryRecord.salt, recoveryRecord.hash, Date.now(), userId),
    db.prepare("DELETE FROM email_reset_challenges WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND purpose = 'reset_password'").bind(userId),
    db.prepare("UPDATE sms_challenges SET status = 'superseded' WHERE user_id = ? AND status IN ('sending','pending')").bind(userId),
  ]);
  return recoveryCode;
}

export async function createSession(userId: number, request: Request) {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  const db = database();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, tokenHash, now + SESSION_LENGTH_MS, now),
    db.prepare("UPDATE users SET last_login_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?")
      .bind(now, now, now, userId),
  ]);
  return sessionCookie(token, request, SESSION_LENGTH_MS / 1000);
}

type AccountTokenPurpose = "verify_email" | "reset_password";

export async function createAccountToken(userId: number, purpose: AccountTokenPurpose, lifetimeMs: number) {
  await ensureAuthTables();
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  const db = database();
  await db.batch([
    db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL").bind(userId, purpose),
    db.prepare(`INSERT INTO account_tokens (user_id, purpose, token_hash, expires_at, used_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)`).bind(userId, purpose, tokenHash, now + lifetimeMs, now),
    db.prepare("DELETE FROM account_tokens WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)")
      .bind(now, now - 24 * 60 * 60 * 1000),
  ]);
  return token;
}

export async function verifyEmailWithToken(token: string) {
  await ensureAuthTables();
  const now = Date.now();
  const db = database();
  const row = await db.prepare(`SELECT id, user_id FROM account_tokens
    WHERE token_hash = ? AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > ? LIMIT 1`)
    .bind(await sha256(token), now).first<{ id: number; user_id: number }>();
  if (!row) return false;
  const claimed = await db.prepare("UPDATE account_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(now, row.id).run();
  if (claimed.meta.changes !== 1) return false;
  await db.prepare("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?").bind(now, now, row.user_id).run();
  return true;
}

export async function manuallyVerifyBusinessForPreview(userId: number) {
  await ensureAuthTables();
  if (!Number.isInteger(userId) || userId <= 0) return false;
  const now = Date.now();
  const db = database();
  const result = await db.prepare(`UPDATE users SET email_verified_at = ?, updated_at = ?
    WHERE id = ? AND is_owner = 0 AND email_verified_at IS NULL`).bind(now, now, userId).run();
  if (result.meta.changes !== 1) return false;
  await db.prepare("DELETE FROM account_tokens WHERE user_id = ? AND purpose = 'verify_email'").bind(userId).run();
  return true;
}

export async function replacePasswordWithToken(token: string, password: string) {
  await ensureAuthTables();
  if (!validPassword(password)) throw new Error("Password must contain 8 to 128 characters.");
  const passwordRecord = await createSecretRecord(password);
  const recoveryCode = createRecoveryCode();
  const recoveryRecord = await createSecretRecord(recoveryCode);
  const tokenHash = await sha256(token);
  const tx = await getClient().transaction("write");
  try {
    const now = Date.now();
    const row = (await tx.execute({ sql: "SELECT t.id, t.user_id FROM account_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.purpose = 'reset_password' AND t.used_at IS NULL AND t.expires_at > ? AND u.email_verified_at IS NOT NULL", args: [tokenHash, now] })).rows[0];
    if (!row) return null;
    await tx.execute({ sql: "UPDATE users SET password_salt = ?, password_hash = ?, recovery_salt = ?, recovery_hash = ?, updated_at = ? WHERE id = ?", args: [passwordRecord.salt, passwordRecord.hash, recoveryRecord.salt, recoveryRecord.hash, now, Number(row.user_id)] });
    await tx.execute({ sql: "DELETE FROM email_reset_challenges WHERE user_id = ?", args: [Number(row.user_id)] });
    await tx.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [Number(row.user_id)] });
    await tx.execute({ sql: "DELETE FROM account_tokens WHERE user_id = ? AND purpose = 'reset_password'", args: [Number(row.user_id)] });
    await tx.execute({ sql: "UPDATE sms_challenges SET status = 'superseded' WHERE user_id = ? AND status IN ('sending','pending')", args: [Number(row.user_id)] });
    await tx.commit();
    return { userId: Number(row.user_id), recoveryCode };
  } finally { tx.close(); }
}

export async function checkAuthRequestLimit(kind: string, email: string, maxRequests = 3) {
  await ensureAuthTables();
  const now = Date.now(), windowMs = 15 * 60 * 1000;
  const result = await getClient().execute({
    sql: `INSERT INTO auth_requests (request_key,request_count,window_started_at,blocked_until) VALUES (?,1,?,NULL)
      ON CONFLICT(request_key) DO UPDATE SET
      request_count = CASE WHEN blocked_until > ? THEN request_count WHEN window_started_at <= ? THEN 1 ELSE request_count + 1 END,
      window_started_at = CASE WHEN blocked_until > ? THEN window_started_at WHEN window_started_at <= ? THEN ? ELSE window_started_at END,
      blocked_until = CASE WHEN blocked_until > ? THEN blocked_until WHEN window_started_at <= ? THEN NULL WHEN request_count + 1 > ? THEN ? ELSE NULL END
      RETURNING request_count, blocked_until`,
    args: [kind + ":" + email, now, now, now - windowMs, now, now - windowMs, now, now, now - windowMs, maxRequests, now + windowMs],
  });
  return Number(result.rows[0].request_count) <= maxRequests && Number(result.rows[0].blocked_until || 0) <= now;
}

export async function deleteUnverifiedUser(userId: number) {
  const db = database();
  await db.batch([
    db.prepare("DELETE FROM account_tokens WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ? AND email_verified_at IS NULL").bind(userId),
  ]);
}

export async function deleteAccount(user: AppUser, password: string) {
  const row = await findUserByEmail(user.email);
  if (!row || !(await verifyUserPassword(row, password))) return false;
  const db = database();
  await deleteWithPaymentGuard(user.id, null, [
    db.prepare("DELETE FROM razorpay_orders WHERE owner_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM business_payment_accounts WHERE owner_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM invoice_deliveries WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_user_id = ?)").bind(user.id),
    db.prepare("DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_user_id = ?)").bind(user.id),
    db.prepare("DELETE FROM invoices WHERE owner_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM product_catalog WHERE owner_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM invoice_sequences WHERE owner_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM payment_transactions WHERE owner_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM payment_dues WHERE owner_user_id = ?").bind(user.id),
    db.prepare("DELETE FROM customer_payments WHERE owner_user_id = ? OR owner_email = ?").bind(user.id, user.storageKey),
    db.prepare("DELETE FROM customers WHERE owner_user_id = ? OR owner_email = ?").bind(user.id, user.storageKey),
    db.prepare("DELETE FROM subscriptions WHERE user_email = ?").bind(user.storageKey),
    db.prepare("DELETE FROM app_settings WHERE user_email = ?").bind(user.storageKey),
    db.prepare("DELETE FROM push_deliveries WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ?)").bind(user.storageKey),
    db.prepare("DELETE FROM push_delivery_slots WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ?)").bind(user.storageKey),
    db.prepare("DELETE FROM push_delivery_claims WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ?)").bind(user.storageKey),
    db.prepare("DELETE FROM push_delivery_items WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ?)").bind(user.storageKey),
    db.prepare("DELETE FROM push_subscriptions WHERE owner_key = ?").bind(user.storageKey),
    db.prepare("DELETE FROM email_reset_challenges WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM account_tokens WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM sms_challenges WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM account_phones WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    db.prepare("DELETE FROM login_attempts WHERE email = ?").bind(user.email),
    db.prepare("DELETE FROM auth_requests WHERE request_key LIKE ?").bind(`%:${user.email}`),
    db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  return true;
}

export async function destroySession(request: Request) {
  const token = readCookie(request.headers.get("cookie") || "", SESSION_COOKIE);
  if (token) await database().prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return sessionCookie("", request, 0);
}

export async function checkLoginRateLimit(email: string) {
  await ensureAuthTables();
  const row = await database().prepare("SELECT attempt_count, window_started_at, locked_until FROM login_attempts WHERE email = ?")
    .bind(email).first<{ attempt_count: number; window_started_at: number; locked_until: number | null }>();
  const now = Date.now();
  if (row?.locked_until && row.locked_until > now) return Math.ceil((row.locked_until - now) / 60_000);
  return 0;
}

export async function recordFailedLogin(email: string) {
  await ensureAuthTables();
  const now = Date.now(), windowMs = 15 * 60 * 1000;
  await getClient().execute({
    sql: `INSERT INTO login_attempts (email,attempt_count,window_started_at,locked_until) VALUES (?,1,?,NULL)
      ON CONFLICT(email) DO UPDATE SET
      attempt_count = CASE WHEN window_started_at <= ? THEN 1 ELSE attempt_count + 1 END,
      window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END,
      locked_until = CASE WHEN locked_until > ? THEN locked_until WHEN window_started_at <= ? THEN NULL WHEN attempt_count + 1 >= 5 THEN ? ELSE NULL END`,
    args: [email, now, now - windowMs, now - windowMs, now, now, now - windowMs, now + windowMs],
  });
}

export async function clearFailedLogins(email: string) {
  await database().prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();
}

function sessionCookie(value: string, request: Request, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${secure ? "; Secure" : ""}`;
}

function readCookie(header: string, name: string) {
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function randomToken(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function createRecoveryCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `YR-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`;
}

function normalizeRecoveryCode(value: string) {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^YR/, "");
  return `YR-${compact.slice(0, 5)}-${compact.slice(5, 10)}-${compact.slice(10, 15)}-${compact.slice(15, 20)}`;
}

async function createSecretRecord(secret: string) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = bytesToBase64Url(saltBytes);
  return { salt, hash: await deriveSecret(secret, saltBytes) };
}

async function verifySecret(secret: string, salt: string, expectedHash: string) {
  const actualHash = await deriveSecret(secret, base64UrlToBytes(salt));
  return safeTextEqual(actualHash, expectedHash);
}

async function deriveSecret(secret: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PASSWORD_ITERATIONS }, material, 256);
  return bytesToBase64Url(new Uint8Array(bits));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function safeTextEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
