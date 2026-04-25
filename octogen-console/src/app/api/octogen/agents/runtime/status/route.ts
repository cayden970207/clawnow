import { NextRequest, NextResponse } from "next/server";
import {
  createOctogenHermesAdapterService,
  octogenErrorResponse,
  requireOctogenWorkspaceAccess,
} from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireOctogenWorkspaceAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createOctogenHermesAdapterService();
    const result = await service.getRuntimeStatus(
      auth.workspaceId,
      request.nextUrl.searchParams.get("agentId"),
    );
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
