import { localDemoAuthEnabled } from "../../../local-demo-auth";
import { AccountEmailError, accountActionUrl, sendAccountEmail, authEmailAvailable } from "../../../auth-email";
import { checkAuthRequestLimit, createAccountToken, deleteUnverifiedUser, normalizeEmail, registerUser, validEmail, validPassword } from "../../../auth";
import { previewManualVerificationEnabled } from "../../../preview-auth";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const displayName = String(payload.displayName || "").trim().slice(0, 100);
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    const ownerSetupCode = String(payload.ownerSetupCode || "").trim();
    if (displayName.length < 2) return Response.json({ error: "Enter your name or business name." }, { status: 400 });
    if (!validEmail(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    if (!validPassword(password)) return Response.json({ error: "Password must contain 8 to 128 characters." }, { status: 400 });
    const localDemo = localDemoAuthEnabled(request);
    if (!localDemo && !previewManualVerificationEnabled() && !authEmailAvailable()) return Response.json({ error: "Account signup is temporarily unavailable because verification email is not configured. Existing accounts can still sign in." }, { status: 503, headers: { "Cache-Control": "no-store" } });
    if (!(await checkAuthRequestLimit("signup", email))) return Response.json({ error: "Too many account requests. Try again in 15 minutes." }, { status: 429 });
    const { user, recoveryCode } = await registerUser({ displayName, email, password, ownerSetupCode });
    try {
      const token = await createAccountToken(user.id, "verify_email", 24 * 60 * 60 * 1000);
      if (localDemo) return Response.json({ user: { email: user.email, displayName: user.displayName }, recoveryCode, verificationRequired: true, localDemoUrl: accountActionUrl(request, "verify", token), message: "Local demo account created. No email was sent. Open the demo verification link below, then sign in." }, { status: 201, headers: { "Cache-Control": "no-store" } });
      await sendAccountEmail({ to: user.email, displayName: user.displayName, kind: "verify", actionUrl: accountActionUrl(request, "verify", token) });
    } catch (emailError) {
      if (previewManualVerificationEnabled() && !user.isOwner) {
        console.warn("YaadRakho Preview email unavailable; account is waiting for owner approval", { userId: user.id, email: user.email });
        return Response.json({
          user: { email: user.email, displayName: user.displayName },
          recoveryCode,
          verificationRequired: true,
          manualApprovalPending: true,
          message: "Account created for Preview. Email delivery is unavailable, so the YaadRakho owner must approve this demo account before sign-in.",
        }, { status: 201, headers: { "Cache-Control": "no-store" } });
      }
      await deleteUnverifiedUser(user.id);
      throw emailError;
    }
    return Response.json({ user: { email: user.email, displayName: user.displayName }, recoveryCode, verificationRequired: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AccountEmailError) return Response.json({ error: error.message, code: error.code }, { status: 503, headers: { "Cache-Control": "no-store" } });
    const message = error instanceof Error ? error.message : "Account could not be created.";
    return Response.json({ error: message.includes("UNIQUE constraint") ? "An account with this email already exists. Please sign in." : message }, { status: 400 });
  }
}
