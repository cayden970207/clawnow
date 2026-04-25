import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenWorkspaceAccess,
  toRequestMeta,
} from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readSessionIdFromBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const raw = (body as { sessionId?: unknown }).sessionId;
  return typeof raw === "string" ? raw.trim() : "";
}

export async function POST(request: NextRequest) {
  const auth = await requireOctogenWorkspaceAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  const body = await request.json().catch(() => ({}));
  const sessionId = readSessionIdFromBody(body);
  if (!sessionId) {
    return NextResponse.json(
      {
        success: false,
        error: "sessionId is required",
        errorCode: "BAD_REQUEST",
      },
      { status: 400 },
    );
  }

  try {
    const service = createOctogenService();
    const result = await service.cancelTerminalOnboarding(
      auth.userId,
      auth.workspaceId,
      sessionId,
      toRequestMeta(request),
    );
    return NextResponse.json({
      success: true,
      vm: result.vm,
      status: result.status,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
