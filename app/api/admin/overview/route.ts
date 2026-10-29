import { getAdminOverview, type AdminBusinessFilter } from "../../../../db/admin-analytics";
import { getCurrentUser } from "../../../auth";
import { previewManualVerificationEnabled } from "../../../preview-auth";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    if (!user.isOwner) return Response.json({ error: "Owner access required" }, { status: 403 });

    const url = new URL(request.url);
    const overview = await getAdminOverview({
      query: url.searchParams.get("q") || "",
      filter: (url.searchParams.get("filter") || "all") as AdminBusinessFilter,
      page: Number(url.searchParams.get("page") || 1),
      pageSize: Number(url.searchParams.get("pageSize") || 20),
    });
    return Response.json({ ...overview, manualVerificationEnabled: previewManualVerificationEnabled() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("YaadRakho owner overview failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Owner dashboard could not be loaded" }, { status: 500 });
  }
}
