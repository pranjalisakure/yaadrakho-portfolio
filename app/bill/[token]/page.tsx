import PaymentInstructions from "../../PaymentInstructions";
import { notFound } from "next/navigation";
import { getPublicInvoice } from "../../../db/sales-billing";
import { razorpayAvailability } from "../../../db/razorpay";
import PrintInvoiceButton from "../../invoices/[id]/PrintInvoiceButton";
import RazorpayPayButton from "./RazorpayPayButton";

export const dynamic = "force-dynamic";

function money(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}
function paidDate(value: number) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

const methodNames: Record<string, string> = { cash: "Cash", upi: "UPI", paytm: "Paytm", bank: "Bank transfer", other: "Other" };


export default async function CustomerBillPage({ params }: { params: Promise<{ token: string }> }) {
  const publicToken = (await params).token;
  const data = await getPublicInvoice(publicToken);
  if (!data) notFound();
  const invoice = data.invoice as unknown as {
    ownerUserId: number; invoiceNumber: string; businessName: string; businessPhone: string; customerName: string; customerPhone: string;
    remainingPayment: string; issueDate: string; dueDate: string; billingMode: string; subtotal: number; discountAmount: number; taxAmount: number;
    totalAmount: number; amountPaid: number; status: string; notes: string;
  };
  const items = data.items as unknown as Array<{ id: number; description: string; quantityMilli: number; unit: string; unitPrice: number; gstRate: number; lineSubtotal: number; lineDiscount: number; lineTax: number; lineTotal: number }>;
  const transactions = (data.transactions || []) as unknown as Array<{ id: number; amount: number; method: string; reference: string; receiptNumber: string; receiptToken: string; balanceAfter: number; receivedAt: number }>;
  const sellerName = String(invoice.businessName || "").trim() || "Business";
  const sellerInitial = sellerName.charAt(0).toUpperCase() || "B";
  const remaining = Math.max(0, Number(invoice.totalAmount) - Number(invoice.amountPaid));
  const onlinePayment = await razorpayAvailability(Number(invoice.ownerUserId));
  const statusLabel = remaining === 0 ? "Paid" : Number(invoice.amountPaid) > 0 ? "Partially paid" : "Payment pending";
  return <main className="invoice-document customer-bill-document">
    <div className="invoice-document-actions"><div><strong>Secure customer bill</strong><small>Invoice and payment status in one place</small></div><PrintInvoiceButton /></div>
    <header><div className="invoice-seller"><span className="brand-mark">{sellerInitial}</span><div><small className="invoice-from-label">FROM</small><h1>{sellerName}</h1>{invoice.businessPhone && <p>{invoice.businessPhone}</p>}</div></div><section><span>INVOICE</span><strong>{invoice.invoiceNumber}</strong><small className={`customer-bill-status ${remaining === 0 ? "paid" : Number(invoice.amountPaid) > 0 ? "partial" : "pending"}`}>{statusLabel}</small></section></header>
    <div className="invoice-meta"><section><small>BILL TO</small><strong>{invoice.customerName}</strong><span>{invoice.customerPhone}</span></section><section><div><small>Bill date</small><strong>{date(invoice.issueDate)}</strong></div><div><small>Payment due</small><strong>{date(invoice.dueDate)}</strong></div><div><small>Status</small><strong>{invoice.status === "issued" ? "Pending" : invoice.status}</strong></div></section></div>
    <section className={`customer-bill-balance invoice-no-print ${remaining === 0 ? "settled" : ""}`}>
      <div><small>{remaining === 0 ? "PAYMENT COMPLETE" : "AMOUNT TO PAY"}</small><strong>{money(remaining)}</strong><p>{remaining === 0 ? "Thank you. This bill has been paid in full." : `Due by ${date(invoice.dueDate)}`}</p></div>
      <div><span>Total bill <b>{money(Number(invoice.totalAmount))}</b></span><span>Received <b>{money(Number(invoice.amountPaid))}</b></span><span>Balance <b>{money(remaining)}</b></span></div>
    </section>
    <PaymentInstructions token={publicToken} remaining={remaining} choice={invoice.remainingPayment} dueDate={invoice.dueDate} status={invoice.status} />
    {remaining > 0 && invoice.remainingPayment === "online" && <RazorpayPayButton publicToken={publicToken} remaining={remaining}
      businessName={sellerName} customerName={invoice.customerName} customerPhone={invoice.customerPhone}
      invoiceNumber={invoice.invoiceNumber} enabled={onlinePayment.enabled} testMode={onlinePayment.testMode} accountStatus={onlinePayment.accountStatus} />}
    <table className="invoice-items-table"><thead><tr><th>#</th><th>Product / service</th><th>Qty</th><th>MRP</th><th>Discount</th><th>GST</th><th>Amount</th></tr></thead><tbody>{items.map((item, index) => <tr key={item.id}><td data-label="#">{index + 1}</td><td data-label="Product / service">{item.description}</td><td data-label="Qty">{item.quantityMilli / 1000} {item.unit}</td><td data-label="MRP">{money(item.unitPrice)}</td><td data-label="Discount">{money(item.lineDiscount)}</td><td data-label="GST">{item.gstRate}%</td><td data-label="Amount">{money(item.lineTotal)}</td></tr>)}</tbody></table>
    <div className="invoice-summary"><section>{invoice.notes && <><small>NOTES</small><p>{invoice.notes}</p></>}<p>Thank you for your business.</p></section><section><span>Base amount <b>{money(Number(invoice.subtotal))}</b></span>{Number(invoice.discountAmount) > 0 && <span>Discount <b>- {money(Number(invoice.discountAmount))}</b></span>}<span>GST <b>{money(Number(invoice.taxAmount))}</b></span><strong>Total <b>{money(Number(invoice.totalAmount))}</b></strong><span>Paid <b>{money(Number(invoice.amountPaid))}</b></span><strong className="balance">Remaining <b>{money(Number(invoice.totalAmount) - Number(invoice.amountPaid))}</b></strong></section></div>
    {transactions.length > 0 && <section className="customer-payment-history">
      <div><small>PAYMENT HISTORY</small><h2>Payments received</h2></div>
      {transactions.map((payment) => <article key={payment.id}><span className="payment-history-check">&#10003;</span><div><strong>{money(Number(payment.amount))}</strong><small>{methodNames[payment.method] || payment.method} | {paidDate(Number(payment.receivedAt))}{payment.reference ? ` | Ref ${payment.reference}` : ""}</small></div><div><small>{payment.receiptNumber || "Receipt"}</small>{payment.receiptToken && <a href={`/receipt/${payment.receiptToken}`}>View receipt &rarr;</a>}</div></article>)}
    </section>}
    <footer><span className={`invoice-status ${invoice.status}`}>{invoice.status === "issued" ? "PAYMENT PENDING" : invoice.status.toUpperCase()}</span><p>Secure digital bill from {sellerName}.</p></footer>
  </main>;
}
