"use client";
import { FormEvent, useState } from "react";
import ResetPasswordForm from "./reset-password/ResetPasswordForm";
export default function EmailPasswordResetForm({initialEmail,onBack}:{initialEmail:string;onBack:()=>void}) {
  const [email,setEmail]=useState(initialEmail),[challenge,setChallenge]=useState(""),[otp,setOtp]=useState(""),[token,setToken]=useState("");
  const [error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  async function send(verify=false) {
    setBusy(true);setError("");setMessage("");
    try {
      const response=await fetch("/api/auth/password/otp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(verify?{action:"verify",challenge,otp}:{email})});
      const data=await response.json();
      if(!response.ok) throw Error(data.error||"Please try again.");
      if(verify) setToken(data.token); else {setChallenge(data.challenge);setOtp("");setMessage(data.message);}
    } catch(e) {setError(e instanceof Error?e.message:"Please try again.");} finally {setBusy(false);}
  }
  async function resendVerification() {
    setBusy(true);setError("");setMessage("");
    try {
      const r=await fetch("/api/auth/resend-verification",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})});
      const d=await r.json();if(!r.ok)throw Error(d.error||"Could not send verification email.");setMessage(d.message);
    }catch(e){setError(e instanceof Error?e.message:"Please try again.");}finally{setBusy(false);}
  }
  if(token)return <ResetPasswordForm token={token}/>;
  return <main className="auth-page"><section className="auth-card"><h1>Forgot your password?</h1><p>1. Enter email · 2. Verify code · 3. Create new password</p><form onSubmit={(e:FormEvent)=>{e.preventDefault();void send(Boolean(challenge));}}>
    <label><span>Email address</span><input required type="email" autoComplete="email" value={email} disabled={Boolean(challenge)||busy} onChange={e=>setEmail(e.target.value)}/></label>
    {challenge&&<label><span>6-digit email code</span><input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={otp} onChange={e=>setOtp(e.target.value.replace(/\D/g,""))}/></label>}
    {error&&<div className="auth-error" role="alert">{error}</div>}{message&&<div className="auth-success" role="status">{message}</div>}
    <button className="primary-button auth-submit" disabled={busy}>{busy?"Please wait…":challenge?"Verify code":"Send email code"}</button></form>
    {challenge&&<><button type="button" className="auth-text-button" disabled={busy} onClick={()=>void send()}>Resend code</button><button type="button" className="auth-text-button" disabled={busy} onClick={()=>{setChallenge("");setOtp("");setError("");setMessage("");}}>Change email</button></>}
    <details><summary>Not verified your signup email yet?</summary><p>New accounts need email verification before password reset.</p><button type="button" className="auth-text-button" disabled={busy||!email} onClick={resendVerification}>Resend signup verification</button></details>
    <button type="button" className="auth-text-button" disabled={busy} onClick={onBack}>Back to sign in</button>
  </section></main>;
}
