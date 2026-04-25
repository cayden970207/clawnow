import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveBundledBootstrapScriptPath } from "../resolve-script-path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const scriptPath = resolveBundledBootstrapScriptPath("octogen-vm-bootstrap.sh");
  if (!scriptPath) {
    return NextResponse.json(
      { success: false, error: "Bootstrap script not found" },
      { status: 404 },
    );
  }

  try {
    const content = await fs.readFile(scriptPath, "utf8");
    return new NextResponse(content, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown script read error";
    return NextResponse.json(
      { success: false, error: `Unable to read script: ${message}` },
      { status: 500 },
    );
  }
}
