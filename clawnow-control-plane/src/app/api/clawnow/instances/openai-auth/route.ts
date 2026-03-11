import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
  toRequestMeta,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readApiKeyFromBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const raw = (body as { apiKey?: unknown }).apiKey;
  return typeof raw === "string" ? raw.trim() : "";
}

export async function POST(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const apiKey = readApiKeyFromBody(body);
    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error: "OpenAI API key is required",
          errorCode: "OPENAI_KEY_REQUIRED",
        },
        { status: 400 },
      );
    }

    const service = createClawNowService();
    const result = await service.configureOpenAiApiKey(auth.userId, apiKey, toRequestMeta(request));
    return NextResponse.json({
      success: true,
      instance: result.instance,
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
