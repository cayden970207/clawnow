import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenWorkspaceAccess,
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
    const result = await service.recoverVm(auth.userId, auth.workspaceId);
    return NextResponse.json({
      success: true,
      action: result.action,
      vm: result.vm,
      message: "Recovery action submitted",
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
