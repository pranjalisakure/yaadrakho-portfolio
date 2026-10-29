import { createOnlinePaymentOrder } from "../../../../db/razorpay";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const result = await createOnlinePaymentOrder(
      String(payload.publicToken || ""),
      payload.amount,
      payload.requestKey,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Online payment could not be started.";
    const unavailable = /not configured|Test Mode is required/.test(message);
    return Response.json({ error: message }, {
      status: unavailable ? 503 : 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
