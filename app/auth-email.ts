import { publicAppUrl } from "./public-app-url";

export function authEmailAvailable() {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.AUTH_EMAIL_FROM?.trim());
}

export class AccountEmailError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AccountEmailError"; }
}

type AccountEmailKind = "verify" | "reset";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  }[character] || character));
}

export function accountActionUrl(request: Request, kind: AccountEmailKind, token: string) {
  const path = kind === "verify" ? "/verify-email" : "/reset-password";
  return `${publicAppUrl(request)}${path}?token=${encodeURIComponent(token)}`;
}

export async function sendAccountEmail(input: {
  to: string;
  displayName: string;
  kind: AccountEmailKind;
  actionUrl: string;
  otp?: string;
}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new AccountEmailError("EMAIL_NOT_CONFIGURED", "Email delivery is not configured. Contact the app owner to complete email setup.");

  const verify = input.kind === "verify";
  const subject = verify ? "Verify your YaadRakho account" : "Reset your YaadRakho password";
  const heading = verify ? "Verify your email address" : "Reset your password";
  const action = verify ? "Verify email" : "Reset password";
  const expiry = verify ? "24 hours" : "30 minutes";
  const name = escapeHtml(input.displayName || "YaadRakho user");
  const actionUrl = escapeHtml(input.actionUrl);
  const response = await fetch("https://api.resend.com/emails", {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `yaadrakho-${input.kind}-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      html: input.otp ? `<h1>Your YaadRakho password reset code</h1><p>${escapeHtml(input.otp)}</p><p>Expires in 10 minutes. Never share this code. Ignore this email if you did not request it.</p>` : `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#14213d">
        <h1>${heading}</h1><p>Hello ${name},</p>
        <p>${verify ? "Confirm this email to activate your YaadRakho account." : "We received a request to change your YaadRakho password."}</p>
        <p><a href="${actionUrl}" style="display:inline-block;padding:13px 20px;border-radius:10px;background:#14213d;color:#fff;text-decoration:none;font-weight:700">${action}</a></p>
        <p>This secure link expires in ${expiry} and can be used only once.</p>
        <p>If you did not request this, you can safely ignore this email.</p>
      </div>`,
      text: input.otp ? `Your YaadRakho password reset code: ${input.otp}. Expires in 10 minutes. Never share this code.` : `${heading}\n\nOpen this secure link: ${input.actionUrl}\n\nThis link expires in ${expiry} and can be used only once.`,
    }),
  }).catch(() => { throw new AccountEmailError("EMAIL_UNAVAILABLE", "Email service could not be reached. Please try again later."); });
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { name?: string; message?: string };
    const providerMessage = String(details.message || "").toLowerCase();
    let code = "EMAIL_PROVIDER_FAILURE";
    let message = "Email service is temporarily unavailable. Please try again later.";
    if ([401, 403].includes(response.status)) {
      code = "EMAIL_PROVIDER_SETUP";
      message = "Email delivery is blocked by the provider. The app owner needs to check the email API key and verified sender. Repeated signup attempts will not fix this.";
      if (providerMessage.includes("testing emails") || providerMessage.includes("own email")) {
        code = "EMAIL_TEST_RECIPIENT_RESTRICTED";
        message = "This preview email service only allows its approved test recipient. The app owner must verify a sender domain before other users can sign up.";
      }
    } else if (response.status === 429) {
      code = "EMAIL_PROVIDER_LIMIT";
      message = "Email provider limit reached. Please wait before trying again.";
    }
    console.error("YaadRakho authentication email failed", { status: response.status, code });
    throw new AccountEmailError(code, message);
  }
}
