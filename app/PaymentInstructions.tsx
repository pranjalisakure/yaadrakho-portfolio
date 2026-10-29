import React from "react";
import { headers } from "next/headers";
import { paymentQrMatrix, paymentQrTarget } from "./payment-qr";

type Props = { token: string; remaining: number; choice: string; dueDate: string; status?: string };

export function PaymentInstructionsContent({ url, remaining, dueDate }: { url: string | null; remaining: number; dueDate: string }) {
  const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(remaining);
  const date = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(dueDate + "T00:00:00"));
  if (!url) return <section className="bill-payment-instructions"><strong>Remaining payment: Cash</strong><p>{amount} due by {date}. Please pay the business in cash.</p></section>;
  const modules = paymentQrMatrix(url);
  const size = modules.size + 8;
  const path: string[] = [];
  for (let row = 0; row < modules.size; row++) for (let col = 0; col < modules.size; col++) {
    if (modules.get(row, col)) path.push(`M${col + 4} ${row + 4}h1v1h-1z`);
  }
  return <section className="bill-payment-instructions">
    <div><strong>Pay the remaining balance online</strong><p>{amount} due by {date}</p><p>Scan with your phone camera to open this bill and pay its current balance.</p><a href={url}>Open secure payment bill</a></div>
    <svg className="bill-payment-qr" xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code to open this bill and pay the remaining balance" shapeRendering="crispEdges"><rect width={size} height={size} fill="#ffffff" /><path d={path.join("")} fill="#000000" /></svg>
  </section>;
}

export default async function PaymentInstructions({ token, remaining, choice, dueDate, status }: Props) {
  if (remaining <= 0 || status === "paid" || status === "cancelled" || !token) return null;
  let origin = process.env.PUBLIC_APP_URL?.trim();
  if (!origin && choice === "online") {
    const requestHeaders = await headers();
    const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host");
    if (!host) return null;
    const protocol = requestHeaders.get("x-forwarded-proto") === "http" || host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
    origin = protocol + "://" + host;
  }
  const url = choice === "online" ? paymentQrTarget(origin!, token, remaining, choice, status) : null;
  if (choice === "online" && !url) return null;
  return <PaymentInstructionsContent url={url} remaining={remaining} dueDate={dueDate} />;
}
