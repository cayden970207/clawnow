import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenWorkspaceAccess,
  toRequestMeta,
} from "@/lib/services/octogen-http";

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
  const auth = await requireOctogenWorkspaceAccess(request);
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

    const service = createOctogenService();
    const result = await service.configureOpenAiApiKey(
      auth.userId,
      auth.workspaceId,
      apiKey,
      toRequestMeta(request),
    );
    return NextResponse.json({
      success: true,
      vm: result.vm,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
