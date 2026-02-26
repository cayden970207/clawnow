import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import {
  clawNowErrorResponse,
  createClawNowService,
  toRequestMeta,
} from "@/lib/services/clawnow-http";

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
  const auth = await requireAuth(request);
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
    const service = createClawNowService();
    const result = await service.cancelTerminalOnboarding(
      auth.userId,
      sessionId,
      toRequestMeta(request),
    );
    return NextResponse.json({
      success: true,
      instance: result.instance,
      status: result.status,
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
