import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import {
  clawNowErrorResponse,
  createClawNowService,
  toRequestMeta,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
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
