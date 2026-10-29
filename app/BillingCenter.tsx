"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import NewBillForm, { BillingCustomer, BillingProduct } from "./NewBillForm";

type Invoice = {
  id: number; customerId: number; customerName: string; customerPhone: string; dueId: number;
  remainingPayment: "online" | "cash"; invoiceNumber: string; billingMode: "separate" | "monthly_statement"; issueDate: string; dueDate: string;
  subtotal: number; discountAmount: number; taxAmount: number; totalAmount: number; amountPaid: number;
  status: "issued" | "partial" | "paid" | "cancelled"; itemCount: number; productSummary: string;
  deliveryAttemptedAt?: number; deliveryReviewNote?: string; deliveryReviewedAt?: number;
  publicToken: string; latestReceiptId?: number; deliveryStatus: "prepared" | "sent" | "failed";
};
type BillingStats = { totalBills: number; pendingBills: number; dueToday: number; overdueBills: number; collectedAmount: number; upcomingReminders: number };
export type BillingTab = "invoice" | "catalog" | "history" | "reminders";

function money(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

function humanDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function parseCsvRow(row: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"' && row[index + 1] === '"' && quoted) { current += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { values.push(current.trim()); current = ""; }
    else current += character;
  }
  values.push(current.trim());
  return values;
}

function parseProductCsv(text: string) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((row) => row.trim()).map(parseCsvRow);
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one product");
  const headers = rows[0].map((header) => header.toLowerCase().replace(/[^a-z]/g, ""));
  const indexOf = (...names: string[]) => headers.findIndex((header) => names.includes(header));
  const nameIndex = indexOf("name", "product", "productname", "item", "itemname");
  const priceIndex = indexOf("price", "mrp", "rate", "unitprice");
  const gstIndex = indexOf("gst", "gstrate", "tax");
  const unitIndex = indexOf("unit", "uom");
  if (nameIndex < 0 || priceIndex < 0) throw new Error("CSV headers must include name and price (or MRP)");
  return rows.slice(1).map((row) => ({
    name: row[nameIndex] || "", price: Number(String(row[priceIndex] || "0").replace(/[^\d.-]/g, "")),
    gstRate: gstIndex >= 0 ? Number(String(row[gstIndex] || "0").replace(/[^\d.-]/g, "")) : 0,
    unit: unitIndex >= 0 ? row[unitIndex] || "item" : "item",
  })).filter((product) => product.name);
}

export default function BillingCenter({ customers, initialTab = "invoice", onClose, onPaymentsUpdated }: {
  customers: BillingCustomer[];
  initialTab?: BillingTab;
  onClose: () => void;
  onPaymentsUpdated: () => void;
}) {
  const [tab, setTab] = useState<BillingTab>(initialTab);
  const [products, setProducts] = useState<BillingProduct[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [localCustomers, setLocalCustomers] = useState(customers);
  const [stats, setStats] = useState<BillingStats>({ totalBills: 0, pendingBills: 0, dueToday: 0, overdueBills: 0, collectedAmount: 0, upcomingReminders: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [productForm, setProductForm] = useState({ name: "", price: 0, gstRate: 0, unit: "item" });
  const [paymentAmounts, setPaymentAmounts] = useState<Record<number, number>>({});
  const [paymentMethod, setPaymentMethod] = useState("upi");
  const [paymentReferences, setPaymentReferences] = useState<Record<number, string>>({});
  const paymentRequestKeys = useRef<Record<number, string>>({});

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const pendingOnly = tab === "reminders";
  const loadRequest = useRef(0);
  const loadBilling = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    try {
      setError("");
      const response = await fetch(`/api/sales-billing?page=${page}&pending=${pendingOnly}`, { cache: "no-store" });
      const data = await response.json() as { products?: BillingProduct[]; invoices?: Invoice[]; stats?: BillingStats; pagination?: { hasMore: boolean }; error?: string };
      if (requestId !== loadRequest.current) return;
      if (!response.ok) throw new Error(data.error || "Billing data could not be loaded");
      setHasMore(Boolean(data.pagination?.hasMore));
      setProducts((data.products || []).map((product) => ({ ...product, id: Number(product.id), price: Number(product.price), gstRate: Number(product.gstRate) })));
      setInvoices((data.invoices || []).map((invoice) => ({ ...invoice, id: Number(invoice.id), customerId: Number(invoice.customerId), dueId: Number(invoice.dueId), latestReceiptId: invoice.latestReceiptId ? Number(invoice.latestReceiptId) : undefined, subtotal: Number(invoice.subtotal), discountAmount: Number(invoice.discountAmount), taxAmount: Number(invoice.taxAmount), totalAmount: Number(invoice.totalAmount), amountPaid: Number(invoice.amountPaid), itemCount: Number(invoice.itemCount) })));
      if (data.stats) setStats(data.stats);
    } catch (caught) { if (requestId === loadRequest.current) setError(caught instanceof Error ? caught.message : "Billing data could not be loaded"); }
    finally { if (requestId === loadRequest.current) setLoading(false); }
  }, [page, pendingOnly]);

  useEffect(() => { const timer = window.setTimeout(() => void loadBilling(), 0); return () => { window.clearTimeout(timer); loadRequest.current += 1; }; }, [loadBilling]);

  async function saveProducts(productRows: Array<{ name: string; price: number; gstRate: number; unit: string }>) {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/sales-billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_products", products: productRows }) });
      const data = await response.json() as { saved?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "Products could not be saved");
      setMessage(`${data.saved || productRows.length} product(s) saved. MRP, GST and unit will auto-fill after selection.`);
      setProductForm({ name: "", price: 0, gstRate: 0, unit: "item" });
      await loadBilling();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Products could not be saved"); }
    finally { setBusy(false); }
  }

  async function submitProduct(event: FormEvent) { event.preventDefault(); await saveProducts([productForm]); }
  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try { await saveProducts(parseProductCsv(await file.text())); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "CSV could not be read"); }
  }

  async function recordInvoicePayment(invoice: Invoice) {
    const remaining = invoice.totalAmount - invoice.amountPaid;
    const amount = Number(paymentAmounts[invoice.id] || remaining);
    const reference = String(paymentReferences[invoice.id] || "").trim();
    if (["upi", "paytm", "bank"].includes(paymentMethod) && !reference) { setError("Enter the UTR or transaction reference for this digital payment"); return; }
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) { setError(`Enter an amount between ₹1 and ${money(remaining)}`); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const idempotencyKey = paymentRequestKeys.current[invoice.id] || crypto.randomUUID();
      paymentRequestKeys.current[invoice.id] = idempotencyKey;
      const response = await fetch(`/api/customers/${invoice.customerId}/payments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount, method: paymentMethod, dueId: invoice.dueId, expectedDueDate: invoice.dueDate, idempotencyKey, reference: reference || invoice.invoiceNumber }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Payment could not be recorded");
      delete paymentRequestKeys.current[invoice.id];
      const paidInFull = amount === remaining;
      setMessage(`${money(amount)} received and saved with today's payment date for ${invoice.invoiceNumber}. ${paidInFull ? "Click “Send paid receipt” to send the updated paid bill on WhatsApp." : "Click “Send payment update” to send the updated pending balance on WhatsApp."}`);
      setPaymentAmounts((current) => ({ ...current, [invoice.id]: 0 }));
      setPaymentReferences((current) => ({ ...current, [invoice.id]: "" }));
      await loadBilling(); onPaymentsUpdated();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Payment could not be recorded"); }
    finally { setBusy(false); }
  }

  async function changeRemainingPayment(invoice: Invoice, remainingPayment: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/sales-billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_remaining_payment", invoiceId: invoice.id, remainingPayment }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Payment choice could not be saved");
      await loadBilling();
      setMessage(remainingPayment === "cash" ? "Cash balance saved. No payment QR will be shown." : "Online balance saved. The bill and part-payment receipts include a QR.");
    } catch (error) { setError(error instanceof Error ? error.message : "Payment choice could not be saved"); }
    finally { setBusy(false); }
  }

  async function reviewDelivery(invoice: Invoice) {
    const note = window.prompt("Check the customer's chat or provider records. Record what you found (10–500 characters). Saving a note does not confirm delivery or resend the message.", invoice.deliveryReviewNote || "");
    if (note === null) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/sales-billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "review_invoice_delivery", invoiceId: invoice.id, note }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Review could not be saved");
      await loadBilling(); setMessage("Delivery review saved. Automatic resend remains blocked. Share manually only if needed.");
    } catch (error) { setError(error instanceof Error ? error.message : "Review could not be saved"); }
    finally { setBusy(false); }
  }

  async function shareInvoice(invoice: Invoice) {
    if (invoice.deliveryAttemptedAt && invoice.deliveryStatus !== "sent" && !window.confirm("Automatic delivery is uncertain. Check whether the customer already received this bill. Continue to manual sharing?")) return;
    setError("");
    const popup = window.open("about:blank", "yaadrakho-invoice-whatsapp");
    if (!popup) {
      setError("WhatsApp could not be opened. Allow pop-ups for YaadRakho and try again.");
      return;
    }
    try {
      const response = await fetch(invoice.latestReceiptId ? `/api/receipts/${invoice.latestReceiptId}` : "/api/sales-billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: invoice.latestReceiptId ? undefined : JSON.stringify({ action: "prepare_invoice_delivery", invoiceId: invoice.id }),
      });
      const data = await response.json() as { delivery?: { whatsappUrl?: string }; whatsappUrl?: string; error?: string };
      const whatsappUrl = data.delivery?.whatsappUrl || data.whatsappUrl;
      if (!response.ok || !whatsappUrl) throw new Error(data.error || "Updated WhatsApp message could not be prepared");
      popup.opener = null;
      popup.location.replace(whatsappUrl);
    } catch (caught) {
      popup.close();
      const message = caught instanceof Error ? caught.message : "Updated WhatsApp bill could not be prepared";
      setError(message);
      console.error("YaadRakho WhatsApp bill error", caught);
    }
  }

  function selectTab(nextTab: BillingTab) { setPage(1); setTab(nextTab); }

  const visibleInvoices = invoices.filter((invoice) => tab === "history" || (invoice.status !== "paid" && invoice.status !== "cancelled"));
  return <div className="modal-backdrop billing-center-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="form-panel billing-center" role="dialog" aria-modal="true" aria-labelledby="sales-billing-title">
      <div className="form-header"><div><span className="eyebrow">Sales &amp; billing</span><h2 id="sales-billing-title">Bills, products and payments</h2><p>Generate each sale once, send the bill, and follow the remaining payment automatically.</p></div><button onClick={onClose} aria-label="Close">×</button></div>
      <div className="billing-tabs" role="tablist"><button className={tab === "invoice" ? "selected" : ""} onClick={() => selectTab("invoice")}>New bill</button><button className={tab === "catalog" ? "selected" : ""} onClick={() => selectTab("catalog")}>Product catalog</button><button className={tab === "history" ? "selected" : ""} onClick={() => selectTab("history")}>Bill history</button><button className={tab === "reminders" ? "selected" : ""} onClick={() => selectTab("reminders")}>Billing reminders</button></div>
      <div className="billing-summary-strip" aria-label="Billing summary"><button onClick={() => selectTab("history")}><small>Total bills</small><strong>{stats.totalBills}</strong></button><button onClick={() => selectTab("history")}><small>Pending bills</small><strong>{stats.pendingBills}</strong></button><button onClick={() => selectTab("reminders")}><small>Due today</small><strong>{stats.dueToday}</strong></button><button onClick={() => selectTab("reminders")}><small>Overdue</small><strong>{stats.overdueBills}</strong></button><button onClick={() => selectTab("history")}><small>Collected</small><strong>{money(stats.collectedAmount)}</strong></button><button onClick={() => selectTab("reminders")}><small>Upcoming reminders</small><strong>{stats.upcomingReminders}</strong></button></div>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
      {message && <div className="success-banner" role="status">{message}<button onClick={() => setMessage("")}>×</button></div>}
      {loading ? <div className="empty-state"><span className="loader" />Loading billing…</div> : tab === "catalog" ? <div className="catalog-layout"><form className="catalog-form" onSubmit={submitProduct}><h3>Add or update product</h3><label><span>Product/service name *</span><input required value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} placeholder="Example: School Uniform" /></label><div className="field-grid"><label><span>MRP / price (₹) *</span><input required type="number" min="0" step="1" value={productForm.price || ""} onChange={(event) => setProductForm({ ...productForm, price: Number(event.target.value) || 0 })} /></label><label><span>GST</span><select value={productForm.gstRate} onChange={(event) => setProductForm({ ...productForm, gstRate: Number(event.target.value) })}>{[0,5,12,18,28].map((rate) => <option key={rate} value={rate}>{rate}%</option>)}</select></label></div><label><span>Unit</span><input value={productForm.unit} onChange={(event) => setProductForm({ ...productForm, unit: event.target.value })} placeholder="set, item, plate, month" /></label><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save product"}</button><label className="csv-import-button"><span>Import CSV</span><input type="file" accept=".csv,text/csv" onChange={importCsv} /><small>Headers: name, price, gst, unit</small></label></form><div className="catalog-list"><h3>Saved products ({products.length})</h3>{products.length === 0 ? <p>No products saved yet.</p> : products.map((product) => <article key={product.id}><div><strong>{product.name}</strong><small>{product.unit} · GST {product.gstRate}%</small></div><b>{money(product.price)}</b></article>)}</div></div>
      : tab === "invoice" ? <NewBillForm products={products} customers={localCustomers} busy={busy} onBusy={setBusy} onProductsChanged={setProducts} onCustomerAdded={(customer) => setLocalCustomers((current) => current.some((entry) => entry.id === customer.id) ? current : [...current, customer])} onError={setError} onCreated={({ invoiceNumber, delivery }) => { const resultMessage = delivery.kind === "partial_receipt" ? `${invoiceNumber} part payment recorded. The receipt and remaining balance are ready to send.` : delivery.kind === "receipt" ? `${invoiceNumber} marked paid. The payment receipt is ready to send.` : delivery.kind === "payment_bill" ? `${invoiceNumber} generated. The secure payment bill is ready to send.` : `${invoiceNumber} generated and reminder set. WhatsApp bill is ready to send.`; setMessage(delivery.status === "sent" ? `${resultMessage} WhatsApp sent automatically.` : resultMessage); selectTab("history"); void loadBilling(); onPaymentsUpdated(); }} />
      : <div className="invoice-history">{visibleInvoices.length === 0 ? <div className="empty-state"><h3>{page > 1 ? "No more bills on this page" : tab === "reminders" ? "No billing reminders" : "No bills generated"}</h3><p>{tab === "reminders" ? "Paid bills stop reminding automatically." : "Create your first bill from the New bill tab."}</p><button className="primary-button" onClick={() => selectTab("invoice")}>Create bill</button></div> : visibleInvoices.map((invoice) => { const remaining = invoice.totalAmount - invoice.amountPaid; const whatsappLabel = remaining === 0 ? "Send paid receipt" : invoice.amountPaid > 0 ? "Send payment update" : "WhatsApp bill"; return <article className="invoice-card" key={invoice.id}><div className="invoice-card-main"><span className={`invoice-status ${invoice.status}`}>{invoice.status === "issued" ? "PENDING" : invoice.status.toUpperCase()}</span><strong>{invoice.invoiceNumber}</strong><h3>{invoice.customerName}</h3><p>{invoice.productSummary}</p><small>{invoice.itemCount} item(s) · Bill {humanDate(invoice.issueDate)} · Due {humanDate(invoice.dueDate)}</small></div><div className="invoice-card-total"><strong>{money(invoice.totalAmount)}</strong><span>{remaining > 0 ? `${money(remaining)} pending` : "Fully paid"}</span></div>{Boolean(invoice.deliveryAttemptedAt) && <div role="status"><small>{invoice.deliveryStatus === "sent" ? "WhatsApp provider accepted the message; delivery/read status is not verified." : "Automatic delivery uncertain. Check before sharing again."}</small>{invoice.deliveryReviewNote && <p>Review note: {invoice.deliveryReviewNote}</p>}{invoice.deliveryStatus !== "sent" && <button className="secondary-button" disabled={busy} onClick={() => void reviewDelivery(invoice)}>Record delivery review</button>}</div>}<div className="invoice-card-actions"><a className="secondary-button" href={`/invoices/${invoice.id}`} target="_blank" rel="noreferrer">Print / PDF</a>{invoice.publicToken && <a className="secondary-button" href={`/bill/${invoice.publicToken}`} target="_blank" rel="noreferrer">Customer bill</a>}<button className="secondary-button" onClick={() => void shareInvoice(invoice)}>{whatsappLabel}</button>{remaining > 0 && <><label><span>Remaining payment</span><select aria-label={`Remaining payment for ${invoice.invoiceNumber}`} value={invoice.remainingPayment} disabled={busy} onChange={event => void changeRemainingPayment(invoice, event.target.value)}><option value="online">Online — payment QR</option><option value="cash">Cash — no QR</option></select></label><input aria-label={`Payment for ${invoice.invoiceNumber}`} type="number" min="1" max={remaining} step="1" placeholder={String(remaining)} value={paymentAmounts[invoice.id] || ""} onChange={(event) => setPaymentAmounts((current) => ({ ...current, [invoice.id]: Number(event.target.value) || 0 }))} /><select aria-label="Payment method" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="upi">UPI</option><option value="paytm">Paytm</option><option value="cash">Cash</option><option value="bank">Bank</option><option value="other">Other</option></select><input className="payment-reference-input" aria-label={`UTR or reference for ${invoice.invoiceNumber}`} placeholder={paymentMethod === "cash" ? "Cash note (optional)" : "UTR / reference"} value={paymentReferences[invoice.id] || ""} onChange={(event) => setPaymentReferences((current) => ({ ...current, [invoice.id]: event.target.value }))} /><button className="primary-button" disabled={busy} onClick={() => void recordInvoicePayment(invoice)}>Record payment & receipt</button></>}</div></article>; })}</div>}
      {(tab === "history" || tab === "reminders") && <nav className="billing-pagination" aria-label="Bill history pages"><button className="secondary-button" disabled={loading || busy || page === 1} onClick={() => setPage(current => current - 1)}>Previous</button><span aria-live="polite">Page {page}</span><button className="secondary-button" disabled={loading || busy || !hasMore} onClick={() => setPage(current => current + 1)}>Next</button></nav>}
    </section>
  </div>;
}
