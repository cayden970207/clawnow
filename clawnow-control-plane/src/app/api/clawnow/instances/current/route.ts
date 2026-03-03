import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { clawNowErrorResponse, createClawNowService } from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createClawNowService();
    const [instance, billing] = await Promise.all([
      service.getCurrentInstance(auth.userId),
      service.getWorkspaceBillingSummary(auth.userId),
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
