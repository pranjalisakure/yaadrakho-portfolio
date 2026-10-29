import { checkLoginRateLimit, clearFailedLogins, createSession, findUserByEmail, normalizeEmail, recordFailedLogin, validEmail, verifyUserPassword } from "../../../auth";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  if (!validEmail(email) || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });
  const minutes = await checkLoginRateLimit(email);
  if (minutes > 0) return Response.json({ error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` }, { status: 429 });
  const user = await findUserByEmail(email);
  if (!user || !(await verifyUserPassword(user, password))) {
    await recordFailedLogin(email);
    return Response.json({ error: "Email or password is incorrect." }, { status: 401 });
  }
  if (user.email_verified_at === null) {
    return Response.json({ error: "Verify your email before signing in. Use the resend verification option if needed.", code: "EMAIL_NOT_VERIFIED" }, { status: 403 });
  }
  await clearFailedLogins(email);
  const cookie = await createSession(user.id, request);
  return Response.json({ user: { email: user.email, displayName: user.display_name } }, {
    headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}
