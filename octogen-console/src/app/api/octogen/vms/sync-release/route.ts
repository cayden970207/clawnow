import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenWorkspaceAccess,
  toRequestMeta,
} from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireOctogenWorkspaceAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createOctogenService();
    const result = await service.syncWorkspaceRelease(
      auth.userId,
      auth.workspaceId,
      toRequestMeta(request),
    );
    return NextResponse.json({
      success: true,
      vm: result.vm,
      updated: result.updated,
      message: result.message,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
