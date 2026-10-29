"use client";

import { FormEvent, useMemo, useRef, useState } from "react";

export type BillingCustomer = { id: number; name: string; phone: string; contactConsent?: boolean };
export type BillingProduct = { id: number; name: string; price: number; gstRate: number; unit: string };
type LineDraft = { key: number; productId: string; query: string; quantity: number; discount: number };
type Delivery = { status: "prepared" | "sent" | "failed"; automatic?: boolean; kind?: "payment_bill" | "due_bill" | "receipt" | "partial_receipt"; whatsappUrl?: string; receiptUrl?: string; error?: string };

let nextLineKey = 1;
function newLine(): LineDraft { return { key: nextLineKey++, productId: "", query: "", quantity: 1, discount: 0 }; }

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function money(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount || 0);
}

function lineTotals(line: LineDraft, products: BillingProduct[]) {
  const product = products.find((entry) => entry.id === Number(line.productId));
  if (!product || line.quantity <= 0) return { product, base: 0, discount: 0, discounted: 0, tax: 0, total: 0 };
  const base = Math.round(product.price * line.quantity);
  const discount = Math.min(Math.max(Math.round(line.discount || 0), 0), base);
  const discounted = base - discount;
  const tax = Math.round(discounted * product.gstRate / 100);
  return { product, base, discount, discounted, tax, total: discounted + tax };
}

export default function NewBillForm({ products, customers, busy, onBusy, onProductsChanged, onCustomerAdded, onCreated, onError }: {
  products: BillingProduct[];
  customers: BillingCustomer[];
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onProductsChanged: (products: BillingProduct[]) => void;
  onCustomerAdded: (customer: BillingCustomer) => void;
  onCreated: (result: { invoiceNumber: string; delivery: Delivery }) => void;
  onError: (message: string) => void;
}) {
  const [customerId, setCustomerId] = useState(customers[0]?.id ? String(customers[0].id) : "");
  const [showNewCustomer, setShowNewCustomer] = useState(customers.length === 0);
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", consent: false });
  const [issueDate, setIssueDate] = useState(dateKey());
  const [dueDate, setDueDate] = useState(dateKey());
  const [billingMode, setBillingMode] = useState<"separate" | "monthly_statement">("separate");
  const [paymentTiming, setPaymentTiming] = useState<"pay_now" | "pay_later" | "already_paid" | "partly_paid">("pay_later");
  const [remainingPayment, setRemainingPayment] = useState<"online" | "cash">("online");
  const [initialPaymentAmount, setInitialPaymentAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("upi");
  const [paymentReference, setPaymentReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [activeSearch, setActiveSearch] = useState<number | null>(null);
  const [addingProductFor, setAddingProductFor] = useState<number | null>(null);
  const [newProduct, setNewProduct] = useState({ name: "", price: 0, gstRate: 0, unit: "item" });
  const [deliveryLink, setDeliveryLink] = useState("");
  const pendingInvoiceKey = useRef("");

  const totals = useMemo(() => lines.reduce((summary, line) => {
    const value = lineTotals(line, products);
    return { base: summary.base + value.base, discount: summary.discount + value.discount, tax: summary.tax + value.tax, total: summary.total + value.total };
  }, { base: 0, discount: 0, tax: 0, total: 0 }), [lines, products]);

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  }

  function chooseProduct(lineKey: number, product: BillingProduct) {
    updateLine(lineKey, { productId: String(product.id), query: product.name });
    setActiveSearch(null);
    setAddingProductFor(null);
  }

  async function saveInlineProduct(lineKey: number) {
    if (!newProduct.name.trim() || newProduct.price < 0 || !newProduct.unit.trim()) { onError("Product name, MRP and unit are required"); return; }
    onBusy(true); onError("");
    try {
      const response = await fetch("/api/sales-billing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_products", products: [newProduct] }) });
      const data = await response.json() as { products?: BillingProduct[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Product could not be saved");
      const loaded = (data.products || []).map((product) => ({ ...product, id: Number(product.id), price: Number(product.price), gstRate: Number(product.gstRate) }));
      const saved = loaded.find((product) => product.name.trim().toLowerCase() === newProduct.name.trim().toLowerCase());
      if (!saved) throw new Error("Product was saved but could not be selected");
      onProductsChanged(loaded);
      chooseProduct(lineKey, saved);
      setNewProduct({ name: "", price: 0, gstRate: 0, unit: "item" });
    } catch (error) { onError(error instanceof Error ? error.message : "Product could not be saved"); }
    finally { onBusy(false); }
  }

  async function createCustomer() {
    const response = await fetch("/api/customers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCustomer.name, phone: newCustomer.phone, followUpDate: dueDate, amount: 0, requirement: "Created from New Bill", status: "new", paymentStatus: "pending", billingCycle: "one_time", notes: "", contactConsent: newCustomer.consent }),
    });
    const data = await response.json() as { customer?: BillingCustomer; duplicateCustomer?: BillingCustomer; error?: string };
    const saved = data.customer || data.duplicateCustomer;
    if (!response.ok && !saved) throw new Error(data.error || "Customer could not be saved");
    if (!saved) throw new Error("Customer could not be selected after saving");
    const normalized = { ...saved, id: Number(saved.id) };
    onCustomerAdded(normalized);
    setCustomerId(String(normalized.id));
    setShowNewCustomer(false);
    return normalized;
  }

  async function submitInvoice(event: FormEvent) {
    event.preventDefault();
    onBusy(true); onError(""); setDeliveryLink("");
    let reservedMessageWindow: Window | null = null;
    try {
      let selectedCustomer = customers.find((entry) => entry.id === Number(customerId));
      if (showNewCustomer) selectedCustomer = await createCustomer();
      if (!selectedCustomer) throw new Error("Select or add a customer");
      if ((paymentTiming === "already_paid" || paymentTiming === "partly_paid") && ["upi", "paytm", "bank"].includes(paymentMethod) && !paymentReference.trim()) {
        throw new Error("Enter the UTR or transaction reference for this digital payment");
      }
      if (paymentTiming === "partly_paid" && (!Number.isSafeInteger(initialPaymentAmount) || initialPaymentAmount <= 0 || initialPaymentAmount >= totals.total)) throw new Error("Part payment must be greater than zero and less than the bill total");
      const idempotencyKey = pendingInvoiceKey.current || crypto.randomUUID();
      pendingInvoiceKey.current = idempotencyKey;
      if (selectedCustomer.contactConsent) reservedMessageWindow = window.open("about:blank", "yaadrakho-bill-message");
      const response = await fetch("/api/sales-billing", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_invoice", idempotencyKey, customerId: selectedCustomer.id, issueDate,
          dueDate: paymentTiming === "pay_later" || paymentTiming === "partly_paid" ? dueDate : issueDate,
          billingMode, notes, paymentTiming, paymentMethod, paymentReference, remainingPayment, initialPaymentAmount,
          lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity, discount: line.discount })) }),
      });
      const data = await response.json() as { invoice?: { invoiceNumber: string }; delivery?: Delivery; error?: string };
      if (!response.ok || !data.invoice || !data.delivery) throw new Error(data.error || "Bill could not be generated");
      if (data.delivery.status === "sent") reservedMessageWindow?.close();
      else if (!data.delivery.automatic && data.delivery.whatsappUrl && selectedCustomer.contactConsent && reservedMessageWindow) reservedMessageWindow.location.href = data.delivery.whatsappUrl;
      else reservedMessageWindow?.close();
      if (data.delivery.whatsappUrl) setDeliveryLink(data.delivery.whatsappUrl);
      pendingInvoiceKey.current = "";
      setLines([newLine()]); setNotes(""); setPaymentReference("");
      onCreated({ invoiceNumber: data.invoice.invoiceNumber, delivery: data.delivery });
    } catch (error) {
      reservedMessageWindow?.close();
      onError(error instanceof Error ? error.message : "Bill could not be generated");
    } finally { onBusy(false); }
  }

  const hasInvalidLine = lines.some((line) => {
    const value = lineTotals(line, products);
    return !value.product || line.quantity <= 0 || line.discount < 0 || line.discount > value.base;
  });

  return <form className="invoice-form exact-bill-form" onSubmit={submitInvoice}>
    <section className="bill-customer-section">
      <div className="invoice-line-heading"><h3>Customer</h3><button type="button" className="text-button" onClick={() => setShowNewCustomer((value) => !value)}>{showNewCustomer ? "Select existing customer" : "+ Add new customer here"}</button></div>
      {showNewCustomer ? <div className="inline-customer-form"><label><span>Customer name *</span><input required value={newCustomer.name} onChange={(event) => setNewCustomer({ ...newCustomer, name: event.target.value })} placeholder="Example: Rohan Sharma" /></label><label><span>Phone number *</span><input required inputMode="tel" value={newCustomer.phone} onChange={(event) => setNewCustomer({ ...newCustomer, phone: event.target.value })} placeholder="98765 43210" /></label><label className="consent-check"><input type="checkbox" checked={newCustomer.consent} onChange={(event) => setNewCustomer({ ...newCustomer, consent: event.target.checked })} /><span>Customer agreed to receive the bill and reminders on WhatsApp.</span></label></div> : <label><span>Select existing customer *</span><select required value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">Choose customer</option>{customers.map((customer) => <option value={customer.id} key={customer.id}>{customer.name} · {customer.phone}</option>)}</select></label>}
    </section>

    <div className="field-grid bill-date-grid"><label><span>Bill date *</span><input required type="date" value={issueDate} onChange={(event) => { const value = event.target.value; setIssueDate(value); if (dueDate < value) setDueDate(value); }} /></label>{(paymentTiming === "pay_later" || paymentTiming === "partly_paid") && <label><span>Payment due date *</span><input required type="date" min={issueDate} value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>}</div>
    <label><span>Bill type</span><select value={billingMode} onChange={(event) => setBillingMode(event.target.value as typeof billingMode)}><option value="separate">Separate bill for this sale</option><option value="monthly_statement">Monthly khata bill (individual invoice)</option></select></label>
    <fieldset className="bill-payment-choice"><legend>Has payment been received?</legend>
      <label><input type="radio" name="paymentTiming" value="pay_now" checked={paymentTiming === "pay_now"} onChange={() => setPaymentTiming("pay_now")} /><span><strong>Collect today — not received yet</strong><small>Create a bill due today and choose Online or Cash for payment.</small></span></label>
      <label><input type="radio" name="paymentTiming" value="pay_later" checked={paymentTiming === "pay_later"} onChange={() => setPaymentTiming("pay_later")} /><span><strong>Collect later — set a due date</strong><small>Save the due date and remind the customer until fully paid.</small></span></label>
      <label><input type="radio" name="paymentTiming" value="partly_paid" checked={paymentTiming === "partly_paid"} onChange={() => setPaymentTiming("partly_paid")} /><span><strong>Some payment received</strong><small>Record the amount received and choose how the balance will be paid.</small></span></label>
      <label><input type="radio" name="paymentTiming" value="already_paid" checked={paymentTiming === "already_paid"} onChange={() => setPaymentTiming("already_paid")} /><span><strong>Full payment received</strong><small>Save full payment and prepare a paid receipt instead of a payment request.</small></span></label>
    </fieldset>
    {paymentTiming === "partly_paid" && <label><span>Amount received now (₹) *</span><input required type="number" min="1" max={Math.max(0, totals.total - 1)} step="1" value={initialPaymentAmount || ""} onChange={event => setInitialPaymentAmount(Number(event.target.value))} /><small>Remaining: {money(Math.max(0, totals.total - initialPaymentAmount))}</small></label>}
    {paymentTiming !== "already_paid" && <label><span>How will the remaining balance be paid?</span><select value={remainingPayment} onChange={event => setRemainingPayment(event.target.value as "online" | "cash")}><option value="online">Online — include payment QR</option><option value="cash">Cash — no payment QR</option></select><small>Reminders continue until the balance is fully paid.</small></label>}
    {paymentTiming === "already_paid" && <p className="payment-choice-note">Fully paid receipts have no payment QR.</p>}
    {paymentTiming !== "pay_later" && <p className="payment-choice-note">Payment date: <strong>{issueDate}</strong>{paymentTiming === "already_paid" ? " - Paid bills will not receive due reminders." : remainingPayment === "online" ? " - A QR opens the bill to pay the remaining balance online." : " - Remaining payment will be collected in cash, without a QR."}</p>}
    {(paymentTiming === "already_paid" || paymentTiming === "partly_paid") && <div className="field-grid"><label><span>Received payment method</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option value="upi">UPI</option><option value="paytm">Paytm</option><option value="cash">Cash</option><option value="bank">Bank</option><option value="other">Other</option></select></label><label><span>{paymentMethod === "cash" || paymentMethod === "other" ? "Payment note (optional)" : "UTR / transaction reference *"}</span><input required={["upi", "paytm", "bank"].includes(paymentMethod)} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder={paymentMethod === "cash" ? "Cash note (optional)" : "Enter payment reference"} /></label></div>}

    <div className="invoice-lines"><div className="invoice-line-heading"><div><h3>Products / services</h3><small>Search and select a saved product. MRP, GST and unit fill automatically.</small></div><button type="button" className="secondary-button" onClick={() => setLines((current) => [...current, newLine()])}>+ Add another item</button></div>
      {lines.map((line, index) => {
        const value = lineTotals(line, products);
        const normalizedQuery = line.query.trim().toLowerCase();
        const matches = normalizedQuery ? products.filter((product) => product.name.toLowerCase().includes(normalizedQuery)).slice(0, 8) : products.slice(0, 8);
        return <article className="invoice-line exact-invoice-line" key={line.key}>
          <div className="product-search-field"><label><span>Product/service *</span><input required role="combobox" aria-autocomplete="list" aria-controls={`product-options-${line.key}`} autoComplete="off" value={line.query} onFocus={() => setActiveSearch(line.key)} onChange={(event) => { updateLine(line.key, { query: event.target.value, productId: "" }); setActiveSearch(line.key); setAddingProductFor(null); }} placeholder="Type product name" aria-expanded={activeSearch === line.key} /></label>
            {activeSearch === line.key && <div id={`product-options-${line.key}`} className="product-suggestions" role="listbox" aria-label={`Product suggestions for item ${index + 1}`}>{matches.map((product) => <button type="button" role="option" aria-selected={line.productId === String(product.id)} key={product.id} onClick={() => chooseProduct(line.key, product)}><span><strong>{product.name}</strong><small>{money(product.price)} · GST {product.gstRate}% · {product.unit}</small></span><b>Select</b></button>)}{matches.length === 0 && <div className="no-product-match"><span>Product not found</span><button type="button" onClick={() => { setAddingProductFor(line.key); setNewProduct({ name: line.query.trim(), price: 0, gstRate: 0, unit: "item" }); setActiveSearch(null); }}>+ Add new product</button></div>}</div>}
          </div>
          {value.product && <div className="selected-product-values"><span><small>MRP</small><b>{money(value.product.price)}</b></span><span><small>GST</small><b>{value.product.gstRate}%</b></span><span><small>Unit</small><b>{value.product.unit}</b></span></div>}
          <label><span>Quantity</span><input required type="number" min="0.001" max="100000" step="0.001" value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: Number(event.target.value) || 0 })} /></label>
          <label><span>Discount (₹)</span><input type="number" min="0" max={value.base} step="1" value={line.discount || ""} placeholder="Optional" onChange={(event) => updateLine(line.key, { discount: Number(event.target.value) || 0 })} /></label>
          <div className="line-calculation"><span>Base {money(value.base)}</span><span>Discount − {money(value.discount)}</span><span>GST {money(value.tax)}</span><strong>Line total {money(value.total)}</strong></div>
          <button type="button" className="remove-line-button" aria-label={`Remove item ${index + 1}`} disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}>×</button>
          {addingProductFor === line.key && <div className="inline-product-form"><h4>Add new product once</h4><label><span>Name *</span><input required value={newProduct.name} onChange={(event) => setNewProduct({ ...newProduct, name: event.target.value })} /></label><label><span>MRP *</span><input required type="number" min="0" step="1" value={newProduct.price || ""} onChange={(event) => setNewProduct({ ...newProduct, price: Number(event.target.value) || 0 })} /></label><label><span>GST</span><select value={newProduct.gstRate} onChange={(event) => setNewProduct({ ...newProduct, gstRate: Number(event.target.value) })}>{[0,5,12,18,28].map((rate) => <option key={rate} value={rate}>{rate}%</option>)}</select></label><label><span>Unit</span><input required value={newProduct.unit} onChange={(event) => setNewProduct({ ...newProduct, unit: event.target.value })} /></label><div><button type="button" className="text-button" onClick={() => setAddingProductFor(null)}>Cancel</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void saveInlineProduct(line.key)}>Save &amp; select</button></div></div>}
        </article>;
      })}
    </div>
    <label><span>Notes</span><textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional bill note" /></label>
    <section className="bill-preview" aria-live="polite"><div><span className="eyebrow">Bill preview</span><h3>Live payable amount</h3><small>The final bill is saved only after Generate Bill.</small></div><div><span>Base amount <b>{money(totals.base)}</b></span><span>Discount <b>− {money(totals.discount)}</b></span><span>GST amount <b>{money(totals.tax)}</b></span><strong>Final payable amount <b>{money(totals.total)}</b></strong></div></section>
    {deliveryLink && <a className="whatsapp-delivery-link" href={deliveryLink} target="_blank" rel="noreferrer">Open WhatsApp bill message again</a>}
    <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setLines([newLine()])}>Clear bill</button><button className="primary-button" disabled={busy || totals.total <= 0 || hasInvalidLine}>{busy ? "Generating…" : "Generate Bill"}</button></div>
  </form>;
}
