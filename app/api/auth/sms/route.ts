import { createSession, getCurrentUser } from "../../../auth";
import { finishSmsChallenge, smsPurpose, startSmsChallenge } from "../../../sms-auth";
import { smsOtpAvailable } from "../../../sms-provider";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!smsOtpAvailable()) return Response.json({ error: "Mobile OTP is not available yet. Use email sign-in or password reset." }, { status: 503, headers });
  try {
    const body = await request.json() as Record<string, unknown>;
    const purpose = smsPurpose(body.purpose);
    const actor = purpose === "enroll" ? await getCurrentUser() : null;
    if (purpose === "enroll" && !actor) return Response.json({ error: "Please sign in first" }, { status: 401, headers });
    if (body.action === "send") return Response.json(await startSmsChallenge({ phone: body.phone, purpose, password: String(body.password || "") }, actor), { headers });
    if (body.action !== "verify") throw new Error("Invalid OTP action");
    const result = await finishSmsChallenge(String(body.challenge || ""), String(body.code || ""), purpose, actor);
    if (purpose === "login") return Response.json({ signedIn: true }, { headers: { ...headers, "Set-Cookie": await createSession(result.userId, request) } });
    if (purpose === "reset") return Response.json({ resetToken: result.resetToken }, { headers });
    return Response.json({ linked: true, message: "Mobile verified. You can now use SMS login and password recovery." }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "OTP could not be verified" }, { status: 400, headers });
  }
}
