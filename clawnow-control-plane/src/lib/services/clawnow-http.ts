import { NextRequest, NextResponse } from "next/server";
import { ClawNowService, ClawNowServiceError } from "@/lib/services/clawnow.service";
import type { ClawNowRequestMeta } from "@/lib/services/clawnow.service";

let clawNowServiceSingleton: ClawNowService | null = null;

export function createClawNowService() {
  if (!clawNowServiceSingleton) {
    clawNowServiceSingleton = new ClawNowService();
  }
  return clawNowServiceSingleton;
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
