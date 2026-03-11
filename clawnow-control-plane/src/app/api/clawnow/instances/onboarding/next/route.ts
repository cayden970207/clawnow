import { NextRequest, NextResponse } from "next/server";
import {
  clawNowErrorResponse,
  createClawNowService,
  requireClawNowOrgAccess,
  toRequestMeta,
} from "@/lib/services/clawnow-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type OnboardingNextBody = {
  sessionId?: unknown;
  answer?: {
    stepId?: unknown;
    value?: unknown;
  };
};

function parseRequestBody(body: OnboardingNextBody): {
  sessionId: string;
  answer?: {
    stepId: string;
    value: unknown;
  };
} {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  const answer = body.answer;
  if (!answer) {
    return { sessionId };
  }

  const stepId = typeof answer.stepId === "string" ? answer.stepId.trim() : "";
  if (!stepId) {
    throw new Error("answer.stepId is required when answer is provided");
  }

  return {
    sessionId,
    answer: {
      stepId,
      value: answer.value,
    },
  };
}

export async function POST(request: NextRequest) {
  const auth = await requireClawNowOrgAccess(request);
  if (!auth.authorized) {
    return auth.response;
  }

  let parsed: {
    sessionId: string;
    answer?: {
      stepId: string;
      value: unknown;
    };
  };
  try {
    const body = (await request.json().catch(() => ({}))) as OnboardingNextBody;
    parsed = parseRequestBody(body);
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Invalid onboarding request",
        errorCode: "BAD_REQUEST",
      },
      { status: 400 },
    );
  }

  try {
    const service = createClawNowService();
    const result = await service.continueTerminalOnboarding(
      auth.userId,
      parsed,
      toRequestMeta(request),
    );
    return NextResponse.json({
      success: true,
      instance: result.instance,
      result: result.result,
    });
  } catch (error) {
    return clawNowErrorResponse(error);
  }
}
