import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenWorkspaceAccess,
} from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readProvisionWorkspaceId(request: NextRequest): Promise<string | null> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    const body = (await request.json()) as { organizationId?: unknown; workspaceId?: unknown };
    const raw = typeof body.workspaceId === "string" ? body.workspaceId : body.organizationId;
    if (typeof raw !== "string") {
      return null;
    }
    const normalized = raw.trim();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const workspaceId = await readProvisionWorkspaceId(request);
  const auth = await requireOctogenWorkspaceAccess(request, { workspaceId });
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createOctogenService();
    const result = await service.provisionWorkspaceVm(auth.userId, auth.workspaceId);
    return NextResponse.json({
      success: true,
      vm: result.vm,
      created: result.created,
      reused: result.reused,
      message: result.created
        ? "Provisioning submitted to Hetzner"
        : "Returning existing dedicated VM",
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
