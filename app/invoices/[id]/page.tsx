import PaymentInstructions from "../../PaymentInstructions";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getInvoice } from "../../../db/sales-billing";
import { getCurrentUser } from "../../auth";
import PrintInvoiceButton from "./PrintInvoiceButton";

export const dynamic = "force-dynamic";

function money(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);
}

function date(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/invoices/${(await params).id}`)}`);
  const id = Number((await params).id);
  const data = Number.isInteger(id) && id > 0 ? await getInvoice(user, id) : null;
  if (!data) notFound();
  const invoice = data.invoice as unknown as {
    publicToken: string; remainingPayment: string; invoiceNumber: string; businessName: string; businessPhone: string; customerName: string; customerPhone: string;
    issueDate: string; dueDate: string; billingMode: string; subtotal: number; discountAmount: number; taxAmount: number; totalAmount: number;
    amountPaid: number; status: string; notes: string;
  };
  const items = data.items as unknown as Array<{ id: number; description: string; quantityMilli: number; unit: string; unitPrice: number; gstRate: number; lineSubtotal: number; lineDiscount: number; lineTax: number; lineTotal: number }>;
  const sellerName = String(invoice.businessName || "").trim() || "Business";
  const sellerInitial = sellerName.charAt(0).toUpperCase() || "B";
  return <main className="invoice-document">
    <div className="invoice-document-actions"><Link href="/">← Back to YaadRakho</Link><PrintInvoiceButton /></div>
    <header><div className="invoice-seller"><span className="brand-mark">{sellerInitial}</span><div><small className="invoice-from-label">FROM</small><h1>{sellerName}</h1>{invoice.businessPhone && <p>{invoice.businessPhone}</p>}</div></div><section><span>TAX INVOICE</span><strong>{invoice.invoiceNumber}</strong></section></header>
    <div className="invoice-meta"><section><small>BILL TO</small><strong>{invoice.customerName}</strong><span>{invoice.customerPhone}</span></section><section><div><small>Bill date</small><strong>{date(invoice.issueDate)}</strong></div><div><small>Due date</small><strong>{date(invoice.dueDate)}</strong></div><div><small>Type</small><strong>{invoice.billingMode === "monthly_statement" ? "Monthly statement" : "Separate sale"}</strong></div></section></div>
    <table className="invoice-items-table"><thead><tr><th>#</th><th>Product / service</th><th>Qty</th><th>MRP</th><th>Discount</th><th>GST</th><th>Amount</th></tr></thead><tbody>{items.map((item, index) => <tr key={item.id}><td data-label="#">{index + 1}</td><td data-label="Product / service">{item.description}</td><td data-label="Qty">{item.quantityMilli / 1000} {item.unit}</td><td data-label="MRP">{money(item.unitPrice)}</td><td data-label="Discount">{money(item.lineDiscount)}</td><td data-label="GST">{item.gstRate}%</td><td data-label="Amount">{money(item.lineTotal)}</td></tr>)}</tbody></table>
    <div className="invoice-summary"><section>{invoice.notes && <><small>NOTES</small><p>{invoice.notes}</p></>}<p>Thank you for your business.</p></section><section><span>Base amount <b>{money(Number(invoice.subtotal))}</b></span>{Number(invoice.discountAmount) > 0 && <span>Discount <b>− {money(Number(invoice.discountAmount))}</b></span>}<span>GST <b>{money(Number(invoice.taxAmount))}</b></span><strong>Total <b>{money(Number(invoice.totalAmount))}</b></strong><span>Received <b>{money(Number(invoice.amountPaid))}</b></span><strong className="balance">Balance <b>{money(Number(invoice.totalAmount) - Number(invoice.amountPaid))}</b></strong></section></div>
    <PaymentInstructions token={invoice.publicToken} remaining={Math.max(0, Number(invoice.totalAmount) - Number(invoice.amountPaid))} choice={invoice.remainingPayment} dueDate={invoice.dueDate} status={invoice.status} />
    <footer><span className={`invoice-status ${invoice.status}`}>{invoice.status === "issued" ? "PAYMENT PENDING" : invoice.status.toUpperCase()}</span><p>Computer-generated invoice from {sellerName}.</p></footer>
  </main>;
}
