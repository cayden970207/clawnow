import { NextRequest, NextResponse } from "next/server";
import { requireAuth, supabaseAdmin } from "@/lib/server-auth";
import { ClawNowService, ClawNowServiceError } from "@/lib/services/clawnow.service";
import type { ClawNowRequestMeta } from "@/lib/services/clawnow.service";

let clawNowServiceSingleton: ClawNowService | null = null;

export function createClawNowService() {
  if (!clawNowServiceSingleton) {
    clawNowServiceSingleton = new ClawNowService();
  }
  return clawNowServiceSingleton;
}

type OrgAccessDenied = { authorized: false; response: NextResponse };
type OrgAccessGranted = { authorized: true; userId: string };
type OrgAccessContext = OrgAccessDenied | OrgAccessGranted;

export async function requireClawNowOrgAccess(request: NextRequest): Promise<OrgAccessContext> {
  const auth = await requireAuth(request);
  if (!auth.authorized) {
    return auth;
  }

  const { count, error } = await supabaseAdmin
    .from("organization_members")
    .select("organization_id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .limit(1);

  if (error) {
    return {
      authorized: false,
      response: NextResponse.json(
        {
          success: false,
          error: "Failed to verify organization access. Please try again.",
          errorCode: "ORG_MEMBERSHIP_CHECK_FAILED",
        },
        { status: 503 },
      ),
    };
  }

  if (!count || count < 1) {
    return {
      authorized: false,
      response: NextResponse.json(
        {
          success: false,
          error: "ClawNow is currently available to organization members only.",
          errorCode: "ORG_MEMBERSHIP_REQUIRED",
        },
        { status: 403 },
      ),
    };
  }

  return {
    authorized: true,
    userId: auth.userId,
  };
}

export function toRequestMeta(request: NextRequest): ClawNowRequestMeta {
  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  let controlUiOrigin: string | null = null;
  if (originHeader) {
    controlUiOrigin = originHeader;
  } else if (refererHeader) {
    try {
      controlUiOrigin = new URL(refererHeader).origin;
    } catch {
      controlUiOrigin = null;
    }
  } else {
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
    if (forwardedHost) {
      try {
        controlUiOrigin = new URL(`${forwardedProto}://${forwardedHost}`).origin;
      } catch {
        controlUiOrigin = null;
      }
    }
  }

  return {
    ip:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      null,
    userAgent: request.headers.get("user-agent") || null,
    controlUiOrigin,
  };
}

export function clawNowErrorResponse(error: unknown): NextResponse {
  if (error instanceof ClawNowServiceError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        errorCode: error.code,
      },
      { status: error.status },
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: "INTERNAL_ERROR",
    },
    { status: 500 },
  );
}
