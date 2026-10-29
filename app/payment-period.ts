export function paymentPeriodLabel(periodKey: unknown) {
  const value = String(periodKey || "").trim();
  if (value.startsWith("one-time:")) return "One-time payment";
  if (value.startsWith("invoice:")) {
    const invoiceNumber = value.slice("invoice:".length).trim();
    return invoiceNumber ? `Bill ${invoiceNumber}` : "Customer bill";
  }
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const date = new Date(`${value}-01T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(date);
    }
  }
  return "Payment due";
}

type OpenPaymentDue = {
  id: number;
  amountDue: number;
  amountPaid: number;
  status: string;
};

export function selectOpenPaymentDue<T extends OpenPaymentDue>(dues: T[], currentDueId?: number | null) {
  const openDues = dues.filter((due) => due.status !== "paid" && Number(due.amountPaid) < Number(due.amountDue));
  return openDues.find((due) => due.id === Number(currentDueId)) || openDues[0] || null;
}

export function paymentDueRemaining(due: OpenPaymentDue | null | undefined) {
  return due ? Math.max(0, Number(due.amountDue) - Number(due.amountPaid)) : 0;
}
