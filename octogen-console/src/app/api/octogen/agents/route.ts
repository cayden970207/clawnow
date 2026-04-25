import { NextRequest, NextResponse } from "next/server";
import {
  createOctogenAgentService,
  octogenErrorResponse,
  requireOctogenWorkspaceAccess,
} from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CreateAgentBody = {
  name?: unknown;
  vmId?: unknown;
  workspaceId?: unknown;
};

async function readCreateAgentBody(request: NextRequest): Promise<CreateAgentBody> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {};
  }
  try {
    return (await request.json()) as CreateAgentBody;
  } catch {
    return {};
  }
}

function readWorkspaceIdFromBody(body: CreateAgentBody): string | null {
  if (typeof body.workspaceId !== "string") {
    return null;
  }
  const normalized = body.workspaceId.trim();
  return normalized.length > 0 ? normalized : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireOctogenWorkspaceAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createOctogenAgentService();
    const [agents, summary] = await Promise.all([
      service.listWorkspaceAgents(auth.workspaceId),
      service.getWorkspaceSummary(auth.workspaceId),
    ]);
    return NextResponse.json({
      success: true,
      agents,
      summary,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const body = await readCreateAgentBody(request);
  const auth = await requireOctogenWorkspaceAccess(request, {
    workspaceId: readWorkspaceIdFromBody(body),
  });
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const service = createOctogenAgentService();
    const result = await service.createWorkspaceAgent(auth.userId, auth.workspaceId, {
      name: body.name,
      vmId: body.vmId,
    });
    const summary = await service.getWorkspaceSummary(auth.workspaceId);
    return NextResponse.json({
      success: true,
      agent: result.agent,
      created: result.created,
      summary,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
