import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
  toRequestMeta,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createClawNowService();
    const result = await service.getLatestOpenAiCodexOAuthUrl(auth.userId, toRequestMeta(request));
    return NextResponse.json({
      success: true,
      instance: result.instance,
      authUrl: result.authUrl,
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
