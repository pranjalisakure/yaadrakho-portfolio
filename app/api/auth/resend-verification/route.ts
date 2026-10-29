import { localDemoAuthEnabled } from "../../../local-demo-auth";
import { accountActionUrl, sendAccountEmail, authEmailAvailable } from "../../../auth-email";
import { checkAuthRequestLimit, createAccountToken, findUserByEmail, normalizeEmail, validEmail } from "../../../auth";
import { previewManualVerificationEnabled } from "../../../preview-auth";

const GENERIC_MESSAGE = "Verification requested. An email is sent only for a registered account that is not yet verified. If you already verified your email, sign in or use Forgot password to receive a reset code. Check Spam if you are waiting for verification.";

export async function POST(request: Request) {
  const payload = await request.json() as Record<string, unknown>;
  const email = normalizeEmail(payload.email);
  if (!validEmail(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  const localDemo = localDemoAuthEnabled(request);
  if (!localDemo && !previewManualVerificationEnabled() && !authEmailAvailable()) return Response.json({ error: "Verification email is unavailable right now." }, { status: 503 });
  if (!(await checkAuthRequestLimit("verify", email))) return Response.json({ error: "Too many verification requests. Wait 15 minutes before trying again. If your email is already verified, use Sign in or Forgot password instead." }, { status: 429, headers: { "Retry-After": "900", "Cache-Control": "no-store" } });
  const user = await findUserByEmail(email);
  if (user && user.email_verified_at === null) {
    try {
      const token = await createAccountToken(user.id, "verify_email", 24 * 60 * 60 * 1000);
      if (localDemo) return Response.json({ localDemoUrl: accountActionUrl(request, "verify", token), message: "Local demo only: open the verification link below. No email was sent." }, { headers: { "Cache-Control": "no-store" } });
      await sendAccountEmail({ to: user.email, displayName: user.display_name, kind: "verify", actionUrl: accountActionUrl(request, "verify", token) });
    } catch (error) {
      console.error("Verification email resend failed", error);
      if (previewManualVerificationEnabled()) {
        return Response.json({
          message: "Email delivery is unavailable in this Preview. Your account is waiting for YaadRakho owner approval.",
          manualApprovalPending: true,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ error: "Verification email could not be sent. Please try again shortly." }, { status: 503 });
    }
  }
  return Response.json({ message: GENERIC_MESSAGE }, { headers: { "Cache-Control": "no-store" } });
}
