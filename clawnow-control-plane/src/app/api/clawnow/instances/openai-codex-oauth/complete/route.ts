import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
  toRequestMeta,
} from "@/lib/services/clawnow-http";
import { codexOAuthSessionService } from "@/lib/services/codex-oauth-session.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  let payload: {
    sessionId?: string;
    callbackUrl?: string;
    applyToGateway?: boolean;
    includeAccessToken?: boolean;
  } = {};
  try {
    payload = (await request.json()) as { sessionId?: string; callbackUrl?: string };
  } catch {
    payload = {};
  }
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  const callbackUrl = typeof payload.callbackUrl === "string" ? payload.callbackUrl.trim() : "";
  const applyToGateway = payload.applyToGateway !== false;
  const includeAccessToken = payload.includeAccessToken === true;
  if (!sessionId || !callbackUrl) {
    return NextResponse.json(
      {
        success: false,
        error: "sessionId and callbackUrl are required",
        errorCode: "BAD_REQUEST",
      },
      { status: 400 },
    );
  }

  try {
    const oauthCredentials = await codexOAuthSessionService.complete(
      auth.userId,
      sessionId,
      callbackUrl,
    );
    if (applyToGateway) {
      const service = createClawNowService();
      await service.configureOpenAiCodexAccessToken(
        auth.userId,
        oauthCredentials.access,
        toRequestMeta(request),
      );
    }
    return NextResponse.json({
      success: true,
      ...(includeAccessToken ? { accessToken: oauthCredentials.access } : {}),
    });
  } catch (error: unknown) {
    return clawNowErrorResponse(error);
  }
}
