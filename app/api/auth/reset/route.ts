import { checkLoginRateLimit, clearFailedLogins, createSession, findUserByEmail, normalizeEmail, recordFailedLogin, replacePassword, validEmail, validPassword, verifyOwnerSetupCode, verifyRecoveryCode } from "../../../auth";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const email = normalizeEmail(payload.email);
  const recoveryCode = String(payload.recoveryCode || "");
  const ownerSetupCode = String(payload.ownerSetupCode || "");
  const password = String(payload.password || "");
  if (!validEmail(email) || (!recoveryCode && !ownerSetupCode)) return Response.json({ error: "Enter your email and recovery code." }, { status: 400 });
  if (!validPassword(password)) return Response.json({ error: "New password must contain 8 to 128 characters." }, { status: 400 });
  const minutes = await checkLoginRateLimit(email);
  if (minutes > 0) return Response.json({ error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` }, { status: 429 });
  const user = await findUserByEmail(email);
  const ownerVerified = verifyOwnerSetupCode(email, ownerSetupCode);
  const recoveryVerified = user && recoveryCode ? await verifyRecoveryCode(user, recoveryCode) : false;
  if (!user || (!ownerVerified && !recoveryVerified)) {
    await recordFailedLogin(email);
    return Response.json({ error: "Email, recovery code, or owner verification code is incorrect." }, { status: 401 });
  }
  if (user.email_verified_at === null) return Response.json({ error: "Verify your email before using account recovery." }, { status: 403 });
  await clearFailedLogins(email);
  const nextRecoveryCode = await replacePassword(user.id, password);
  const cookie = await createSession(user.id, request);
  return Response.json({ recoveryCode: nextRecoveryCode }, {
    headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}
