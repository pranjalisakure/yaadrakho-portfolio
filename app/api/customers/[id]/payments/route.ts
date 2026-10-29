import { getCustomerLedger, getOwnerLedger, recordLedgerPayment } from "../../../../../db/payment-ledger";
import { getCurrentUser } from "../../../../auth";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  const ledger = await getCustomerLedger(user, id);
  if (!ledger) return Response.json({ error: "Customer not found" }, { status: 404 });
  return Response.json(ledger);
}

export async function POST(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    const result = await recordLedgerPayment(user, id, {
      amount: Number(payload.amount), method: String(payload.method || "other"),
      reference: String(payload.reference || ""), note: String(payload.note || ""),
      receivedAt: payload.receivedAt ? Number(payload.receivedAt) : undefined,
      idempotencyKey: String(payload.idempotencyKey || ""), expectedDueDate: payload.expectedDueDate ? String(payload.expectedDueDate) : undefined,
      dueId: payload.dueId ? Number(payload.dueId) : undefined,
    });
    const ownerLedger = await getOwnerLedger(user);
    return Response.json({ ...result, customer: ownerLedger.customers.find((customer) => Number(customer.id) === id), stats: ownerLedger.stats });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Monthly payment could not be recorded" }, { status: 400 });
  }
}
