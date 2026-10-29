import { setInvoicePaymentChoice } from "../../../db/invoice-payment-choice";
import { paymentReceivedAt } from "../../payment-date";
import { reviewInvoiceDelivery, createInvoice, getBillingOverview, prepareInvoiceDelivery, saveCatalogProducts, sendPreparedInvoiceDelivery } from "../../../db/sales-billing";
import { recordLedgerPayment } from "../../../db/payment-ledger";
import { prepareReceiptDelivery } from "../../../db/payment-receipts";
import { getCurrentUser } from "../../auth";
import { publicAppUrl } from "../../public-app-url";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const page = Number(params.get("page") || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) return Response.json({ error: "Invalid bill history page" }, { status: 400 });
    return Response.json(await getBillingOverview(user, undefined, { page, pendingOnly: params.get("pending") === "true" }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Billing data could not be loaded" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(payload.action || "");
    if (action === "save_products") {
      const products = Array.isArray(payload.products) ? payload.products as Array<{ name: unknown; price: unknown; gstRate?: unknown; unit?: unknown }> : [];
      const result = await saveCatalogProducts(user, products);
      return Response.json({ ...result, ...(await getBillingOverview(user)) });
    }
    if (action === "create_invoice") {
      const paymentTiming = ["pay_now", "pay_later", "already_paid", "partly_paid"].includes(String(payload.paymentTiming))
        ? String(payload.paymentTiming)
        : "pay_later";
      if (paymentTiming === "partly_paid" && (!Number.isSafeInteger(Number(payload.initialPaymentAmount)) || Number(payload.initialPaymentAmount) <= 0)) throw new Error("Enter a positive whole-rupee part payment");
      const hasPayment = paymentTiming === "already_paid" || paymentTiming === "partly_paid";
      const method = String(payload.paymentMethod || "other");
      const reference = String(payload.paymentReference || "").trim();
      if (hasPayment && ["upi", "paytm", "bank"].includes(method) && !reference) throw new Error("Enter the UTR or transaction reference for this digital payment");
      const billDate = String(payload.issueDate || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
      const receivedAt = hasPayment ? (payload.paymentReceivedAt === undefined ? paymentReceivedAt(billDate) : Number(payload.paymentReceivedAt)) : undefined;
      if (receivedAt !== undefined && (!Number.isSafeInteger(receivedAt) || receivedAt < Date.UTC(2000, 0, 1) || receivedAt > Date.now() + 300_000)) throw new Error("Enter a valid payment date");
      const result = await createInvoice(user, {
        customerId: payload.customerId,
        idempotencyKey: payload.idempotencyKey,
        issueDate: payload.issueDate,
        dueDate: payload.dueDate,
        billingMode: payload.billingMode,
        remainingPayment: payload.remainingPayment,
        initialPaymentAmount: paymentTiming === "partly_paid" ? payload.initialPaymentAmount : undefined,
        notes: payload.notes,
        lines: Array.isArray(payload.lines) ? payload.lines as Array<{ productId: unknown; quantity: unknown; discount?: unknown }> : [],
      });
      if (hasPayment) {
        const payment = await recordLedgerPayment(user, result.customerId, {
          amount: paymentTiming === "partly_paid" ? Number(payload.initialPaymentAmount) : result.totalAmount,
          method: String(payload.paymentMethod || "other"),
          reference: String(payload.paymentReference || result.invoiceNumber),
          note: `Payment received while creating ${result.invoiceNumber}`,
          idempotencyKey: `${String(payload.idempotencyKey || result.invoiceNumber).slice(0, 110)}-paid`,
          dueId: result.dueId,
          expectedDueDate: String(payload.dueDate || ""),
          receivedAt,
        });
        const receipt = await prepareReceiptDelivery(user, Number(payment.paymentId), publicAppUrl(request));
        return Response.json({
          invoice: result,
          delivery: { status: "prepared", automatic: false, kind: paymentTiming === "partly_paid" ? "partial_receipt" : "receipt", whatsappUrl: receipt.whatsappUrl, receiptUrl: receipt.receiptUrl },
        }, { status: 201 });
      }
      const delivery = await sendPreparedInvoiceDelivery(user, result.id, publicAppUrl(request));
      return Response.json({ invoice: result, delivery: { ...delivery, kind: paymentTiming === "pay_now" ? "payment_bill" : "due_bill" } }, { status: 201 });
    }
    if (action === "set_remaining_payment") {
      const invoiceId = Number(payload.invoiceId);
      if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new Error("A valid bill is required");
      await setInvoicePaymentChoice(user, invoiceId, payload.remainingPayment);
      return Response.json({ updated: true });
    }
    if (action === "review_invoice_delivery") {
      const invoiceId = Number(payload.invoiceId);
      if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new Error("A valid bill is required");
      return Response.json(await reviewInvoiceDelivery(user, invoiceId, payload.note));
    }
    if (action === "prepare_invoice_delivery") {
      const invoiceId = Number(payload.invoiceId);
      if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
        return Response.json({ error: "A valid bill is required" }, { status: 400 });
      }
      return Response.json({
        delivery: await prepareInvoiceDelivery(user, invoiceId, publicAppUrl(request)),
      });
    }
    return Response.json({ error: "Unknown billing action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Billing action could not be completed" }, { status: 400 });
  }
}
