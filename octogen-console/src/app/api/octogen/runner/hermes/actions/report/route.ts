import { NextRequest, NextResponse } from "next/server";
import { OctogenHermesRunnerService } from "@/lib/services/octogen-hermes-runner.service";
import { octogenErrorResponse } from "@/lib/services/octogen-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  try {
    const service = new OctogenHermesRunnerService();
    const auth = await service.authenticateRequest(request, bodyText);
    const result = await service.reportAction(auth, service.parseBody(bodyText));
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return octogenErrorResponse(error);
  }
}
