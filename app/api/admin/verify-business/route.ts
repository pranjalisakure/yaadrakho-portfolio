import { getCurrentUser, manuallyVerifyBusinessForPreview } from "../../../auth";
import { previewManualVerificationEnabled } from "../../../preview-auth";

export async function PATCH(request: Request) {
  try {
    if (!previewManualVerificationEnabled()) {
      return Response.json({ error: "Manual business approval is available only in the protected Preview environment." }, { status: 403 });
    }
    const owner = await getCurrentUser();
    if (!owner) return Response.json({ error: "Please sign in first" }, { status: 401 });
    if (!owner.isOwner) return Response.json({ error: "Owner access required" }, { status: 403 });
    const payload = await request.json() as { userId?: unknown };
    const userId = Number(payload.userId);
    const approved = await manuallyVerifyBusinessForPreview(userId);
    if (!approved) return Response.json({ error: "This business is already approved or could not be found." }, { status: 409 });
    console.info("YaadRakho Preview business manually approved", { ownerId: owner.id, businessUserId: userId });
    return Response.json({ approved: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("YaadRakho Preview business approval failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Business approval failed" }, { status: 500 });
  }
}
