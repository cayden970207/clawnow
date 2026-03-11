import { NextRequest, NextResponse } from "next/server";
import { requireClawNowOrgAccess } from "@/lib/services/clawnow-http";
import { codexOAuthSessionService } from "@/lib/services/codex-oauth-session.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const result = await codexOAuthSessionService.start(auth.userId);
    return NextResponse.json({
      success: true,
      sessionId: result.sessionId,
      authUrl: result.authUrl,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to start OpenAI Codex OAuth",
        errorCode: "CODEX_OAUTH_START_FAILED",
      },
      { status: 502 },
    );
  }
}
