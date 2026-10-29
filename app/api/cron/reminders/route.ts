import { indiaHour, sendDueReminders } from "../../../push-reminders";

export const dynamic = "force-dynamic";

const allowedReminderHours = new Set(["09", "11", "12", "13", "15", "17", "18", "19", "21"]);

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const timestamp = Date.now();
    const requestedHour = new URL(request.url).searchParams.get("hour");
    const reminderHour = requestedHour || indiaHour(timestamp);
    if (!allowedReminderHours.has(reminderHour)) {
      return Response.json({ error: "Invalid reminder hour" }, { status: 400 });
    }
    const result = await sendDueReminders(timestamp, `hour-${reminderHour}`, reminderHour);
    console.info("YaadRakho reminder job completed", result);
    const retryNeeded = result.failed > result.removedSubscriptions;
    return Response.json({ ok: !retryNeeded, ...result }, { status: retryNeeded ? 503 : 200, headers: { "Cache-Control": "private, no-store", ...(retryNeeded ? { "Retry-After": "30" } : {}) } });
  } catch (error) {
    console.error("YaadRakho reminder job failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Reminders could not be sent" }, { status: 500 });
  }
}
