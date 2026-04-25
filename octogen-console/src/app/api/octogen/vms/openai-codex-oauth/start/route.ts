import { NextRequest, NextResponse } from "next/server";
import { codexOAuthSessionService } from "@/lib/services/codex-oauth-session.service";
import { requireOctogenWorkspaceAccess } from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await requireOctogenWorkspaceAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const result = await codexOAuthSessionService.start(auth.userId, auth.workspaceId);
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
