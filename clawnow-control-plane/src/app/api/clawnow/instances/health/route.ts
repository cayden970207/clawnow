import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function shouldSyncProvider(request: NextRequest): boolean {
  const raw = request.nextUrl.searchParams.get("sync");
  if (!raw) {
    return true;
  }
  return !["0", "false", "no"].includes(raw.toLowerCase());
}

export async function GET(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createClawNowService();
    const health = await service.getInstanceHealth(auth.userId, {
      syncProvider: shouldSyncProvider(request),
    });
    return NextResponse.json({
      success: true,
      ...health,
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
