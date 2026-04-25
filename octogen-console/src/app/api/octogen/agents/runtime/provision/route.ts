import { NextRequest, NextResponse } from "next/server";
import {
  createOctogenAgentService,
  createOctogenHermesAdapterService,
  octogenErrorResponse,
  requireOctogenWorkspaceAccess,
} from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProvisionRuntimeBody = {
  agentId?: unknown;
  workspaceId?: unknown;
};

async function readBody(request: NextRequest): Promise<ProvisionRuntimeBody> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {};
  }
  try {
    return (await request.json()) as ProvisionRuntimeBody;
  } catch {
    return {};
  }
}

function readWorkspaceId(body: ProvisionRuntimeBody): string | null {
  if (typeof body.workspaceId !== "string") {
    return null;
  }
  const normalized = body.workspaceId.trim();
  return normalized.length > 0 ? normalized : null;
}

export async function POST(request: NextRequest) {
  const body = await readBody(request);
  const auth = await requireOctogenWorkspaceAccess(request, {
    workspaceId: readWorkspaceId(body),
  });
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const runtimeService = createOctogenHermesAdapterService();
    const agentService = createOctogenAgentService();
    const result = await runtimeService.provisionRuntime(
      auth.userId,
      auth.workspaceId,
      body.agentId,
    );
    const summary = await agentService.getWorkspaceSummary(auth.workspaceId);
    return NextResponse.json({
      success: true,
      ...result,
      summary,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
