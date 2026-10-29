"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import EmailPasswordResetForm from "./EmailPasswordResetForm";
import SmsAuthForm from "./SmsAuthForm";
import { OWNER_EMAIL } from "./billing-config";

type Mode = "login" | "signup" | "forgot";

export default function AuthForm({ initialMode, smsEnabled = false, localDemo = false, emailEnabled = true }: { initialMode: "login" | "signup"; smsEnabled?: boolean; localDemo?: boolean; emailEnabled?: boolean }) {
  const [localDemoUrl, setLocalDemoUrl] = useState("");
  const [mobileMode, setMobileMode] = useState<"login" | "reset" | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ownerSetupCode, setOwnerSetupCode] = useState("");
  const [accountCreated, setAccountCreated] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [unverified, setUnverified] = useState(false);
  const [loading, setLoading] = useState(false);
  const isOwnerEmail = email.trim().toLowerCase() === OWNER_EMAIL.toLowerCase();

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setLocalDemoUrl("");
    setError("");
    setMessage("");
    setUnverified(false);
    setPassword("");
    setConfirmPassword("");
    setAccountCreated(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setUnverified(false);
    if ((mode === "signup") && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const endpoint = mode === "signup" ? "/api/auth/signup" : mode === "forgot" ? "/api/auth/forgot" : "/api/auth/login";
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName, email, password, ownerSetupCode }) });
      const data = await response.json() as { error?: string; code?: string; message?: string; recoveryCode?: string; verificationRequired?: boolean; manualApprovalPending?: boolean; localDemoUrl?: string };
      if (!response.ok) {
        if (data.code === "EMAIL_NOT_VERIFIED") setUnverified(true);
        throw new Error(data.error || "Please try again.");
      }
      if (data.localDemoUrl && localDemo) setLocalDemoUrl(data.localDemoUrl);
      if (mode === "forgot") {
        setMessage(data.message || "If the account exists, a secure reset link has been sent.");
      } else if (mode === "signup") {
        setAccountCreated(true);
        if (data.verificationRequired) setMessage(data.message || "Verification email sent. Verify your email before signing in.");
      } else {
        window.location.href = "/";
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function resendVerification() {
    setLoading(true);
    setError("");
    setMessage("");
    setLocalDemoUrl("");
    try {
      const response = await fetch("/api/auth/resend-verification", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const data = await response.json() as { error?: string; message?: string; localDemoUrl?: string };
      if (!response.ok) throw new Error(data.error || "Verification email could not be sent.");
      if (data.localDemoUrl && localDemo) setLocalDemoUrl(data.localDemoUrl);
      setMessage(data.message || "Verification requested. Already verified? Sign in or use Forgot password for a reset code.");
      setUnverified(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Verification email could not be sent.");
    } finally {
      setLoading(false);
    }
  }

  if (mode === "forgot" && !localDemo) return <EmailPasswordResetForm initialEmail={email} onBack={() => changeMode("login")} />;

  if (mobileMode) return <main className="auth-page"><section className="auth-card"><h1>{mobileMode === "login" ? "Sign in with SMS OTP" : "Reset password with SMS OTP"}</h1><SmsAuthForm purpose={mobileMode} enabled={smsEnabled} /><button type="button" className="auth-text-button" onClick={() => setMobileMode(null)}>Back to email sign-in</button></section></main>;

  if (accountCreated) {
    return <main className="auth-page"><section className="auth-card"><h1>Check your email</h1><p>{message || "Account created. Open the verification link in your email, then sign in."}</p>{error && <div className="auth-error" role="alert">{error}</div>}{localDemo && localDemoUrl && <a className="primary-button" href={localDemoUrl}>Verify this demo account</a>}<button className="secondary-button auth-submit" disabled={loading} onClick={resendVerification}>Resend verification email</button><button className="primary-button auth-submit" onClick={() => changeMode("login")}>Continue to sign in</button></section></main>;
  }

  const title = mode === "signup" ? "Create your free account" : mode === "forgot" ? "Forgot your password?" : "Welcome back";
  const intro = mode === "signup" ? "Create your free early-access account. No payment is required." : mode === "forgot" ? "Enter your verified email. We will send a secure password-reset link." : "Sign in to open your customer dashboard.";

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link className="brand auth-brand" href="/"><span className="brand-mark">Y</span><span><strong>YaadRakho</strong><small>Customer follow-up</small></span></Link>
        <span className="eyebrow">Secure YaadRakho account</span>{localDemo && <p className="auth-success" role="status">Local demo — no email or SMS is sent. You can create a demo account and open its verification/reset link here. Use a demo email such as myshop@example.test.</p>}{!localDemo && !emailEnabled && <p role="status">New signup and email password reset are unavailable until email delivery is connected. Existing users can still sign in.</p>}<h1>{title}</h1><p>{intro}</p>
        {(mode === "login" || mode === "signup") && <div className="auth-tabs" role="tablist" aria-label="Account action"><button type="button" className={mode === "login" ? "selected" : ""} onClick={() => changeMode("login")}>Sign in</button><button type="button" className={mode === "signup" ? "selected" : ""} onClick={() => changeMode("signup")}>Create account</button></div>}
        <form onSubmit={submit}>
          {mode === "signup" && <label><span>Owner or business name</span><input required minLength={2} autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Example: Pranjali Enterprises" /></label>}
          <label><span>Email address</span><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
          {mode !== "forgot" && <label><span>Password</span><input required minLength={8} maxLength={128} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Minimum 8 characters" /></label>}
          {(mode === "signup") && <label><span>Confirm password</span><input required minLength={8} maxLength={128} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter password again" /></label>}
          {mode === "signup" && isOwnerEmail && <details className="owner-code"><summary>YaadRakho owner verification</summary><label><span>Owner setup code</span><input value={ownerSetupCode} onChange={(event) => setOwnerSetupCode(event.target.value)} placeholder="Private code for the YaadRakho owner" /></label></details>}
          {error && <div className="auth-error" role="alert">{error}</div>}{message && <div className="auth-success" role="status">{message}</div>}
          {(unverified || mode === "forgot") && <button className="secondary-button auth-submit" type="button" disabled={loading} onClick={resendVerification}>Resend verification email</button>}
          <button className="primary-button auth-submit" disabled={loading}>{loading ? "Please wait…" : mode === "signup" ? "Create free account" : mode === "forgot" ? "Send reset link" : "Sign in"}</button>
        </form>
        {localDemo && localDemoUrl && mode === "login" && <a className="primary-button" href={localDemoUrl}>Verify this demo account</a>}
        {localDemo && localDemoUrl && mode === "forgot" && <a className="primary-button" href={localDemoUrl}>{localDemoUrl.includes("/verify-email") ? "Verify this demo account" : "Open demo password reset"}</a>}
        {smsEnabled && (mode === "login" || mode === "forgot") && <><button className="auth-text-button" type="button" onClick={() => setMobileMode("login")}>Sign in with mobile OTP</button><button className="auth-text-button" type="button" onClick={() => setMobileMode("reset")}>Forgot password? Use mobile OTP</button></>}
        {mode === "login" && <><button className="auth-text-button" type="button" onClick={() => changeMode("forgot")}>Forgot password? Reset with email code</button></>}
        {mode === "forgot" && <p>Email not verified yet? Use “Resend verification email” above. Verify your email first, then return here to request a password reset. No password is needed to resend verification.</p>}
        {(mode === "forgot") && <button className="auth-text-button" type="button" onClick={() => changeMode("login")}>Back to sign in</button>}
        <div className="auth-trust"><span>Private customer data</span><span>30-day secure session</span></div>
      </section>
      <aside className="auth-side"><span className="eyebrow">YaadRakho mobile app</span><h2>Your follow-ups, always within reach.</h2><p>Install YaadRakho on your phone and open it directly from your home screen.</p><div className="auth-side-card"><strong>Free during development</strong><small>No payment required</small></div></aside>
    </main>
  );
}
