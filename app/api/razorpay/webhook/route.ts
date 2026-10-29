import {
  fallbackWebhookEventId,
  recoverWebhookOrder,
  finalizeCapturedRazorpayPayment,
  finalizeRazorpayTransfer,
  finishWebhookEvent,
  razorpayWebhookSecret,
  rememberWebhookEvent,
  verifyWebhookSignature,
} from "../../../../db/razorpay";

export const dynamic = "force-dynamic";

type WebhookPayload = {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        captured?: boolean;
        method?: string;
        wallet?: string | null;
      };
    };
    transfer?: {
      entity?: {
        id?: string;
        source?: string;
        recipient?: string;
        status?: string;
        error?: { description?: string } | null;
      };
    };
  };
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";
  let secret: string;
  try {
    secret = razorpayWebhookSecret();
  } catch (error) {
    console.error("Razorpay webhook is not configured", error);
    return Response.json({ error: "Webhook is not configured." }, { status: 503 });
  }
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    console.warn("Rejected Razorpay webhook with an invalid signature");
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  let payload: WebhookPayload;

  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return Response.json({ error: "Webhook body is invalid." }, { status: 400 });
  }
  const eventType = String(payload.event || "");
  const eventId = request.headers.get("x-razorpay-event-id") || fallbackWebhookEventId(rawBody);
  const shouldProcess = await rememberWebhookEvent(eventId, eventType);
  if (!shouldProcess) return Response.json({ ok: true, duplicate: true });
  if (["transfer.processed", "transfer.failed", "transfers.failed"].includes(eventType)) {
    const transfer = payload.payload?.transfer?.entity;
    try {
      await finalizeRazorpayTransfer(transfer || {}, eventType !== "transfer.processed");
      await finishWebhookEvent(eventId, "processed", "");
      return Response.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook transfer could not be recorded.";
      if (message === "Razorpay transfer is not linked to a YaadRakho business.") {
        await finishWebhookEvent(eventId, "ignored", message);
        return Response.json({ ok: true, ignored: true });
      }
      await finishWebhookEvent(eventId, "failed", message);
      console.error("Razorpay transfer webhook processing failed", { eventId, eventType, message });
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (!["payment.captured", "order.paid"].includes(eventType)) {
    await finishWebhookEvent(eventId, "ignored", "");
    return Response.json({ ok: true, ignored: true });
  }
  const payment = payload.payload?.payment?.entity;
  if (!payment?.id || !payment.order_id) {
    await finishWebhookEvent(eventId, "failed", "Captured payment data is missing.");
    return Response.json({ error: "Captured payment data is missing." }, { status: 400 });
  }
  try {
    await recoverWebhookOrder(payment.order_id);
    await finalizeCapturedRazorpayPayment(payment.order_id, payment);
    await finishWebhookEvent(eventId, "processed", "");
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook payment could not be recorded.";
    await finishWebhookEvent(eventId, "failed", message);
    console.error("Razorpay webhook processing failed", { eventId, eventType, message });
    return Response.json({ error: message }, { status: 500 });
  }
}
