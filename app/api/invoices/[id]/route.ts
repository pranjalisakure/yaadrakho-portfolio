import { getInvoice } from "../../../../db/sales-billing";
import { getCurrentUser } from "../../../auth";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid bill ID" }, { status: 400 });
  const invoice = await getInvoice(user, id);
  if (!invoice) return Response.json({ error: "Bill not found" }, { status: 404 });
  return Response.json(invoice);
}
