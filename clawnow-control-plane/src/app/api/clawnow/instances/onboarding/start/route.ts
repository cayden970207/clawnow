import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
  toRequestMeta,
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
    const result = await service.startTerminalOnboarding(auth.userId, toRequestMeta(request));
    return NextResponse.json({
      success: true,
      instance: result.instance,
      sessionId: result.sessionId,
      result: result.result,
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
