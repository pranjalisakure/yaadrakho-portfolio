import { checkAuthRequestLimit, normalizeEmail, validEmail } from "../../../../auth";
import { AccountEmailError, authEmailAvailable } from "../../../../auth-email";
import { requestEmailReset, verifyEmailReset } from "../../../../email-password-reset";
const reply=(body: object,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request: Request) {
  const p=await request.json().catch(()=>({})) as Record<string,unknown>;
  if(p.action==="verify") {
    const challenge=String(p.challenge||""),otp=String(p.otp||"");
    if(!/^[a-f0-9]{64}$/.test(challenge)||!/^\d{6}$/.test(otp)) return reply({error:"Enter the 6-digit code from your email."},400);
    try {
      const token=await verifyEmailReset(challenge,otp);
      return token ? reply({token}) : reply({error:"Code is incorrect, expired or already used. After 5 attempts, request a new code."},400);
    } catch {return reply({error:"Verification is temporarily unavailable. Please try again."},503);}
  }
  const email=normalizeEmail(p.email);
  if(!validEmail(email)) return reply({error:"Enter a valid email address."},400);
  if(!authEmailAvailable()) return reply({error:"Email delivery is not configured. Please contact the app owner."},503);
  if(!await checkAuthRequestLimit("email-reset-otp",email) || !await checkAuthRequestLimit("email-reset-global","all",100)) return reply({error:"Too many code requests. Please wait 15 minutes before trying again."},429);
  try {
    const challenge=await requestEmailReset(email);
    return reply({challenge,message:"If this email has a verified account, a 6-digit code has been requested. Check Inbox and Spam. The code expires in 10 minutes."});
  } catch(error) {
    return reply({error:error instanceof AccountEmailError ? error.message : "Unable to send a code right now. Please try again later."},503);
  }
}
