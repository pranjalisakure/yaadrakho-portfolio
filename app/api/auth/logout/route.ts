import { destroySession } from "../../../auth";

export async function POST(request: Request) {
  const cookie = await destroySession(request);
  return new Response(null, {
    status: 303,
    headers: { Location: new URL("/", request.url).toString(), "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}
