import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenOrgAccess,
  readWorkspaceIdFromRequest,
} from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await requireOctogenOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const requestedWorkspaceId = readWorkspaceIdFromRequest(request);
    const workspaceId =
      requestedWorkspaceId ||
      (auth.workspaces.length === 1 ? auth.workspaces[0]?.id || null : null);
    if (
      requestedWorkspaceId &&
      !auth.workspaces.some((workspace) => workspace.id === workspaceId)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "You do not have access to the selected workspace.",
          errorCode: "WORKSPACE_ACCESS_DENIED",
        },
        { status: 403 },
      );
    }
    const service = createOctogenService();
    const billing = await service.getWorkspaceBillingSummary(auth.userId, {
      workspaceId,
    });
    const vm = workspaceId ? await service.getCurrentWorkspaceVm(auth.userId, workspaceId) : null;
    return NextResponse.json({
      success: true,
      vm,
      billing,
      config: service.getConfigSummary(),
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
