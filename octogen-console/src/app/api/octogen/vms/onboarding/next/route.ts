import { NextRequest, NextResponse } from "next/server";
import {
  octogenErrorResponse,
  createOctogenService,
  requireOctogenWorkspaceAccess,
  toRequestMeta,
} from "@/lib/services/octogen-http";

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
  const auth = await requireOctogenWorkspaceAccess(request);
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
    const service = createOctogenService();
    const result = await service.continueTerminalOnboarding(
      auth.userId,
      auth.workspaceId,
      parsed,
      toRequestMeta(request),
    );
    return NextResponse.json({
      success: true,
      vm: result.vm,
      result: result.result,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
