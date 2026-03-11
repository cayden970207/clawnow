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

  let payload: { accessToken?: string } = {};
  try {
    payload = (await request.json()) as { accessToken?: string };
  } catch {
    payload = {};
  }

  const accessToken = typeof payload.accessToken === "string" ? payload.accessToken.trim() : "";
  if (!accessToken) {
    return NextResponse.json(
      {
        success: false,
        error: "accessToken is required",
        errorCode: "BAD_REQUEST",
      },
      { status: 400 },
    );
  }

  try {
    const service = createClawNowService();
    const result = await service.configureOpenAiCodexAccessToken(
      auth.userId,
      accessToken,
      toRequestMeta(request),
    );
    return NextResponse.json({
      success: true,
      instance: result.instance,
    });
  } catch (error: unknown) {
    return clawNowErrorResponse(error);
  }
}
