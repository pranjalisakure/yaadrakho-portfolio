"use client";

export default function PrintInvoiceButton() {
  return <button className="invoice-print-button" onClick={() => window.print()}>Print / Save as PDF</button>;
}
