import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function resolveScriptPath(scriptName: string): string | null {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "scripts", scriptName),
    path.resolve(cwd, "..", "scripts", scriptName),
    path.resolve(cwd, "..", "..", "scripts", scriptName),
  ];
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function GET() {
  const scriptPath = resolveScriptPath("clawnow-control-ui-updater.sh");
  if (!scriptPath) {
    return NextResponse.json(
      { success: false, error: "Control UI updater script not found" },
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
