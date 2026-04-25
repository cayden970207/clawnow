import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenWorkspaceAccess,
} from "@/lib/services/octogen-http";

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
  const auth = await requireOctogenWorkspaceAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createOctogenService();
    const health = await service.getVmHealth(auth.userId, auth.workspaceId, {
      syncProvider: shouldSyncProvider(request),
    });
    return NextResponse.json({
      success: true,
      ...health,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
