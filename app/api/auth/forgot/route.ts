import { localDemoAuthEnabled } from "../../../local-demo-auth";
import { accountActionUrl, sendAccountEmail, authEmailAvailable } from "../../../auth-email";
import { checkAuthRequestLimit, createAccountToken, findUserByEmail, normalizeEmail, validEmail } from "../../../auth";

const GENERIC_MESSAGE = "If an account exists for this email, a secure password-reset link has been sent.";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const email = normalizeEmail(payload.email);
  if (!validEmail(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  const localDemo = localDemoAuthEnabled(request);
  if (!localDemo && !authEmailAvailable()) return Response.json({ error: "Password-reset email is unavailable right now. Use your saved recovery code or contact the app owner." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!(await checkAuthRequestLimit("forgot", email))) return Response.json({ message: GENERIC_MESSAGE });
  const user = await findUserByEmail(email);
  if (user && user.email_verified_at !== null) {
    try {
      const token = await createAccountToken(user.id, "reset_password", 30 * 60 * 1000);
      if (localDemo) return Response.json({ message: "Local demo only: no email was sent. Open the password-reset link below.", localDemoUrl: accountActionUrl(request, "reset", token) }, { headers: { "Cache-Control": "no-store" } });
      await sendAccountEmail({ to: user.email, displayName: user.display_name, kind: "reset", actionUrl: accountActionUrl(request, "reset", token) });
    } catch (error) {
      console.error("Forgot-password email failed", error);
    }
  }
  return Response.json({ message: localDemo ? "No verified demo account was found for this email. Create an account and open its demo verification link first." : GENERIC_MESSAGE }, { headers: { "Cache-Control": "no-store" } });
}
