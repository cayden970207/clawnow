import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { clawNowErrorResponse, createClawNowService } from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createClawNowService();
    const result = await service.provisionUserInstance(auth.userId);
    return NextResponse.json({
      success: true,
      instance: result.instance,
      created: result.created,
      reused: result.reused,
      message: result.created
        ? "Provisioning submitted to Hetzner"
        : "Returning existing dedicated VM",
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
