"use client";

import { useState } from "react";

type RazorpayResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayInstance = {
  open: () => void;
  on: (event: "payment.failed", handler: (response: { error?: { description?: string } }) => void) => void;
};

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

async function loadCheckout() {
  if (window.Razorpay) return;
  const source = "https://checkout.razorpay.com/v1/checkout.js";
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${source}"]`);
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Razorpay Checkout could not be loaded.")), { once: true });
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded. Check your internet and try again."));
    document.head.appendChild(script);
  });
}

function requestKey() {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `pay_${random}`;
}

export default function RazorpayPayButton({
  publicToken,
  remaining,
  businessName,
  customerName,
  customerPhone,
  invoiceNumber,
  enabled,
  testMode,
  accountStatus,
}: {
  publicToken: string;
  remaining: number;
  businessName: string;
  customerName: string;
  customerPhone: string;
  invoiceNumber: string;
  enabled: boolean;
  testMode: boolean;
  accountStatus?: string;
}) {
  const [amount, setAmount] = useState(remaining);
  const [busy, setBusy] = useState(false);
  const [paymentNeedsReview, setPaymentNeedsReview] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function startPayment() {
    setError("");
    setMessage("");
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) {
      setError(`Enter a whole amount between ₹1 and ₹${remaining}.`);
      return;
    }
    setBusy(true);
    try {
      await loadCheckout();
      if (!window.Razorpay) throw new Error("Razorpay Checkout is unavailable.");
      const orderResponse = await fetch("/api/razorpay/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicToken, amount, requestKey: requestKey() }),
      });
      const order = await orderResponse.json() as {
        keyId?: string; orderId?: string; amountPaise?: number; currency?: string; error?: string;
      };
      if (!orderResponse.ok || !order.keyId || !order.orderId) {
        throw new Error(order.error || "Online payment could not be started.");
      }
      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: order.currency,
        name: businessName,
        description: `Bill ${invoiceNumber}`,
        order_id: order.orderId,
        prefill: { name: customerName, contact: customerPhone },
        notes: { invoice_number: invoiceNumber },
        theme: { color: "#14213d" },
        retry: { enabled: true },
        modal: {
          ondismiss: () => {
            setBusy(false);
            setMessage("Payment window closed. If money was deducted, wait for confirmation before paying again.");
          },
        },
        handler: async (payment: RazorpayResponse) => {
          try {
            const verificationResponse = await fetch("/api/razorpay/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payment),
            });
            const verification = await verificationResponse.json() as { paid?: boolean; error?: string; reconciliationRequired?: boolean; message?: string };
            if (verification.reconciliationRequired) {
              setPaymentNeedsReview(true);
              setBusy(false);
              setMessage(verification.message || "Payment received. Contact the business; do not pay again.");
              return;
            }
            if (!verificationResponse.ok || !verification.paid) {
              throw new Error(verification.error || "Payment verification is pending.");
            }
            setMessage("Payment received successfully. The bill balance has been updated.");
            window.setTimeout(() => window.location.reload(), 900);
          } catch (verificationError) {
            setError(verificationError instanceof Error ? verificationError.message : "Payment could not be verified.");
            setBusy(false);
          }
        },
      });
      checkout.on("payment.failed", (response) => {
        setError(response.error?.description || "Payment failed. No amount was added to the bill.");
        setBusy(false);
      });
      checkout.open();
    } catch (paymentError) {
      setError(paymentError instanceof Error ? paymentError.message : "Online payment could not be started.");
      setBusy(false);
    }
  }

  if (!enabled) {
    return <section className="invoice-online-payment invoice-no-print">
      <div><strong>Online payment</strong><p>{accountStatus === "pending" ? "This business is completing its secure payment account setup." : "Online payment is not available for this business right now."}</p></div>
    </section>;
  }

  return <section className="invoice-online-payment invoice-no-print">
    <div>
      <strong>Pay this bill online {testMode && <small>TEST MODE</small>}</strong>
      <p>Pay the full balance or enter a smaller amount for a partial payment.</p>
    </div>
    <label>
      Amount (₹)
      <input type="number" min={1} max={remaining} step={1} value={amount}
        onChange={(event) => setAmount(Number(event.target.value))} disabled={busy || paymentNeedsReview} />
    </label>
    <button type="button" className="primary-button" onClick={startPayment} disabled={busy || paymentNeedsReview}>
      {busy ? "Opening secure payment…" : `Pay ₹${amount || 0}`}
    </button>
    {message && <p className="form-success" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
