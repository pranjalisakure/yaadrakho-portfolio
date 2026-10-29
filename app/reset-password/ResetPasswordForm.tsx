"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

export default function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/password/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }) });
      const data = await response.json() as { error?: string; recoveryCode?: string };
      if (!response.ok) throw new Error(data.error || "Password could not be reset.");
      setCompleted(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Password could not be reset.");
    } finally {
      setLoading(false);
    }
  }

  if (completed) return <main className="auth-page"><section className="auth-card"><span className="success-mark">✓</span><h1>Password updated</h1><p>Your new password is ready. You are signed in and can continue to your dashboard.</p><button className="primary-button" type="button" onClick={() => { window.location.href = "/"; }}>Open YaadRakho</button></section></main>;

  return <main className="auth-page"><section className="auth-card"><Link className="brand auth-brand" href="/"><span className="brand-mark">Y</span><span><strong>YaadRakho</strong><small>Customer follow-up</small></span></Link><span className="eyebrow">Secure password reset</span><h1>Choose a new password</h1><p>Enter and confirm your new password. This reset authorization expires shortly.</p><form onSubmit={submit}><label><span>New password</span><input required minLength={8} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label><span>Confirm password</span><input required minLength={8} maxLength={128} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="primary-button auth-submit" disabled={loading || token.length < 20}>{loading ? "Please wait…" : "Reset password"}</button></form></section></main>;
}
