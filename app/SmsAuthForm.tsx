"use client";

import { FormEvent, useState } from "react";

export default function SmsAuthForm({ purpose, enabled }: { purpose: "login" | "reset" | "enroll"; enabled: boolean }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  if (!enabled) return <p role="status">Mobile OTP is not available yet. Please use email and password, or the email password-reset option.</p>;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: challenge ? "verify" : "send", purpose, phone, password: challenge ? undefined : password, challenge, code }) });
      const data = await response.json() as { challenge?: string; error?: string; message?: string; resetToken?: string; signedIn?: boolean; linked?: boolean };
      if (!response.ok) throw new Error(data.error || "OTP could not be completed");
      setPassword("");
      if (data.signedIn) { window.location.href = "/"; return; }
      if (data.resetToken) { window.location.href = "/reset-password?token=" + encodeURIComponent(data.resetToken); return; }
      if (data.linked) { setLinked(true); setChallenge(""); setCode(""); }
      if (data.challenge) setChallenge(data.challenge);
      setMessage(data.message || "Mobile verified.");
    } catch (error) { setError(error instanceof Error ? error.message : "OTP could not be completed"); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit}>
    <p>{purpose === "enroll" ? "Verify your own mobile number to enable SMS login and password recovery. Changing your business contact number does not change your login number." : "Use the mobile number you previously verified in account settings."}</p>
    {!linked && <><label><span>Indian mobile number</span><input required type="tel" autoComplete="tel" inputMode="tel" maxLength={18} value={phone} disabled={busy || Boolean(challenge)} onChange={event => setPhone(event.target.value)} placeholder="+91 9876543210" /></label>
    {purpose === "enroll" && !challenge && <label><span>Current password</span><input required type="password" autoComplete="current-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>}
    {challenge && <label><span>SMS code</span><input required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{4,10}" minLength={4} maxLength={10} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>}
    <button className="primary-button auth-submit" disabled={busy}>{busy ? "Please wait…" : challenge ? "Verify OTP" : "Send SMS OTP"}</button>
    {challenge && <button className="auth-text-button" type="button" disabled={busy} onClick={() => { setChallenge(""); setCode(""); setMessage(""); setError(""); }}>Request a new code or change number</button>}</>}
    {message && <p className="auth-success" role="status">{message}</p>}{error && <p className="auth-error" role="alert">{error}</p>}
  </form>;
}
