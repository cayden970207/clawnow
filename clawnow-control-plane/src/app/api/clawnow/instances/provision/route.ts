import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readProvisionOrganizationId(request: NextRequest): Promise<string | null> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    const body = (await request.json()) as { organizationId?: unknown };
    if (typeof body.organizationId !== "string") {
      return null;
    }
    const normalized = body.organizationId.trim();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const organizationId = await readProvisionOrganizationId(request);
    const service = createClawNowService();
    const result = await service.provisionUserInstance(auth.userId, { organizationId });
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
