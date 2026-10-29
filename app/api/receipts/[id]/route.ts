import { getCurrentUser } from "../../../auth";
import { publicAppUrl } from "../../../public-app-url";
import { getOwnerReceipt, prepareReceiptDelivery } from "../../../../db/payment-receipts";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  const receiptId = Number((await params).id);
  if (!Number.isSafeInteger(receiptId) || receiptId <= 0) return Response.json({ error: "Invalid receipt" }, { status: 400 });
  const receipt = await getOwnerReceipt(user, receiptId);
  if (!receipt) return Response.json({ error: "Payment receipt was not found" }, { status: 404 });
  return Response.json({ receipt });
}

export async function POST(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    const receiptId = Number((await params).id);
    if (!Number.isSafeInteger(receiptId) || receiptId <= 0) return Response.json({ error: "Invalid receipt" }, { status: 400 });
    return Response.json(await prepareReceiptDelivery(user, receiptId, publicAppUrl(request)));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Receipt could not be prepared" }, { status: 400 });
  }
}
