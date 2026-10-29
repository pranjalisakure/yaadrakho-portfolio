export function paymentReceivedAt(date: string, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Select a valid payment date");
  const noon = Date.parse(date + "T12:00:00+05:30");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  if (!Number.isFinite(noon) || new Date(noon + 19800000).toISOString().slice(0, 10) !== date || date > today) {
    throw new Error("Select today or an earlier valid payment date");
  }
  return date === today ? now : noon;
}
