import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createClawNowService();
    const result = await service.recoverInstance(auth.userId);
    return NextResponse.json({
      success: true,
      action: result.action,
      instance: result.instance,
      message: "Recovery action submitted",
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
