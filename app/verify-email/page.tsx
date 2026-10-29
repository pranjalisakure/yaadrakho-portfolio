import { localDemoAuthEnabled } from "../local-demo-auth";
import Link from "next/link";
import { verifyEmailWithToken } from "../auth";

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = String((await searchParams).token || "");
  const verified = token.length >= 20 && await verifyEmailWithToken(token);
  return (
    <main className="auth-page">
      <section className="auth-card recovery-card">
        <Link className="brand auth-brand" href="/"><span className="brand-mark">Y</span><span><strong>YaadRakho</strong><small>Customer follow-up</small></span></Link>
        <span className={verified ? "success-mark" : "error-mark"}>{verified ? "✓" : "!"}</span>
        <h1>{verified ? (localDemoAuthEnabled() ? "Demo account verified" : "Email verified") : "Verification link unavailable"}</h1>
        <p>{verified ? "Your YaadRakho account is active. You can now sign in securely." : "This link is invalid, expired, or already used. Request a fresh verification email from the sign-in page."}</p>
        <Link className="primary-button auth-submit" href="/login">{verified ? "Continue to sign in" : "Back to sign in"}</Link>
      </section>
    </main>
  );
}
