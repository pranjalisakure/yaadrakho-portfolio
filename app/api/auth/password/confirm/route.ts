import { createSession, replacePasswordWithToken, validPassword } from "../../../../auth";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const token = String(payload.token || "");
  const password = String(payload.password || "");
  if (token.length < 20) return Response.json({ error: "This password-reset link is invalid or incomplete." }, { status: 400 });
  if (!validPassword(password)) return Response.json({ error: "New password must contain 8 to 128 characters." }, { status: 400 });
  const result = await replacePasswordWithToken(token, password);
  if (!result) return Response.json({ error: "This password-reset link is invalid, expired, or already used." }, { status: 400 });
  const cookie = await createSession(result.userId, request);
  return Response.json({ recoveryCode: result.recoveryCode }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
}
