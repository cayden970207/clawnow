import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const organizationId = request.nextUrl.searchParams.get("orgId");
    const service = createClawNowService();
    const [instance, billing] = await Promise.all([
      service.getCurrentInstance(auth.userId),
      service.getWorkspaceBillingSummary(auth.userId, { organizationId }),
    ]);
    return NextResponse.json({
      success: true,
      instance,
      billing,
      config: service.getConfigSummary(),
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
