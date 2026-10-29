"use client";

const sizes = [
  ["a4", "A4 / PDF"],
  ["80mm", "80mm bill printer"],
  ["58mm", "58mm bill printer"],
] as const;

export default function PrintReceiptControls({ paper, receiptNumber }: { paper: "a4" | "80mm" | "58mm"; receiptNumber: string }) {
  function changePaper(nextPaper: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("paper", nextPaper);
    window.location.assign(url.toString());
  }

  function downloadReceipt() {
    const receipt = document.querySelector<HTMLElement>(".receipt-card");
    if (!receipt) return;
    const styles = `body{margin:0;padding:24px;background:#f7f3e8;color:#111c3b;font-family:Arial,sans-serif}.receipt-card{max-width:760px;margin:auto;border:1px solid #ddd4c3;background:#fffdf8}.receipt-card>header{padding:22px;background:#14213d;color:white}.receipt-card section,.receipt-card dl,.receipt-card footer{padding:18px 22px}.receipt-card dl{display:grid;grid-template-columns:1fr 1fr;gap:12px}.receipt-card dd{margin:4px 0;font-weight:700}.receipt-amount{text-align:center}.receipt-amount>strong{color:#176046;font-size:36px}.receipt-card footer{text-align:center;background:#f2faf6}.bill-payment-instructions{display:flex;align-items:center;gap:16px;flex-wrap:wrap;break-inside:avoid}.bill-payment-qr{width:160px;height:160px;flex-shrink:0;background:white}@media(max-width:600px){body{padding:0}.receipt-card dl{grid-template-columns:1fr}}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${receiptNumber}</title><style>${styles}</style></head><body>${receipt.outerHTML}</body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${receiptNumber.replace(/[^A-Za-z0-9_-]/g, "-")}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return <div className="receipt-actions invoice-no-print">
    <div><strong>Print payment receipt</strong><small>Select the paper loaded in your printer.</small></div>
    <div>{sizes.map(([value, label]) => <button type="button" className={paper === value ? "selected" : ""} key={value} onClick={() => changePaper(value)}>{label}</button>)}<button type="button" onClick={downloadReceipt}>Download receipt</button><button type="button" className="primary-button" onClick={() => window.print()}>Print / Save PDF</button></div>
  </div>;
}
